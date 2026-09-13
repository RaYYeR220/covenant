// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {
    INativeQueryVerifier,
    NativeQueryVerifierLib
} from "@gluwa/asc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

import {IChainInfo, ChainInfoLib} from "./interfaces/IChainInfo.sol";
import {ICovenantPool} from "./interfaces/ICovenantPool.sol";
import {ICreditRecord} from "./interfaces/ICreditRecord.sol";
import {SourceRegistry} from "./SourceRegistry.sol";
import {CovenantPredicates} from "./libraries/CovenantPredicates.sol";
import {CovenantEvaluator} from "./libraries/CovenantEvaluator.sol";
import {Term, Line, Status, CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE} from "./libraries/Types.sol";

/// @title CovenantManager
/// @notice Attestcoin smart contract for covenant-backed credit lines on Creditcoin.
///         A borrower posts a WCTC bond, links a source-chain wallet, and accepts covenants over that
///         wallet (no Aave liquidation, no borrow above a cap, no large outflow of a pledged token).
///         Anyone can prove a breach with an inclusion proof verified by the Native Query Verifier
///         precompile and earn a bounty from the bond; unresolved breaches settle into a default.
/// @dev Follows the Attestcoin readability pattern (verify via precompile 0x0FD2, dedupe, decode with
///      EvmV1Decoder, apply app logic). All `logIndex` arguments are the 0-based position of the log inside
///      the proven transaction's receipt (`receiptLogs` as decoded by EvmV1Decoder), never the block-level
///      RPC log index.
contract CovenantManager is SourceRegistry, EIP712, Nonces, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants

    uint256 public constant BPS = 10_000;
    uint256 public constant YEAR = 365 days;
    uint256 public constant MAX_TERMS = 8;

    uint256 public constant WEIGHT_CROSS_DEFAULT = 10_000;
    uint256 public constant WEIGHT_DEBT_CAP = 7500;
    uint256 public constant WEIGHT_NEGATIVE_PLEDGE = 5000;
    uint256 public constant HISTORY_BOOST_PER_REPAY = 2500;
    uint256 public constant MAX_HISTORY_REPAYS = 4; // 4 * 2500 = +10000 bps cap
    uint256 public constant KEEPER_REWARD_BPS = 50;

    uint256 public constant MIN_LEVERAGE_BPS = 10_000;
    uint256 public constant MAX_LEVERAGE_BPS = 40_000;
    uint256 public constant MAX_APR_BPS = 5000;
    uint256 public constant MAX_BOUNTY_BPS = 2500;
    uint256 public constant MIN_GRACE_PERIOD = 10 minutes;
    uint256 public constant MAX_GRACE_PERIOD = 30 days;

    bytes32 public constant LINK_WALLET_TYPEHASH =
        keccak256("LinkWallet(address borrower,address wallet,uint256 nonce,uint256 deadline)");

    // ------------------------------------------------------------------ immutables

    /// @notice Native Query Verifier precompile (0x0FD2).
    INativeQueryVerifier public immutable VERIFIER;
    /// @notice ChainInfo precompile (0x0FD3).
    IChainInfo public immutable CHAIN_INFO;
    IERC20 public immutable WCTC;
    ICovenantPool public immutable POOL;
    ICreditRecord public immutable CREDIT_RECORD;

    // ------------------------------------------------------------------ parameters (owner, bounded)

    uint256 public aprBps = 1200;
    uint256 public bountyBps = 1000;
    uint256 public gracePeriod = 1 hours;
    uint256 public maxLeverageBps = 40_000;
    uint256 public perLineCap = 100_000 ether;
    /// @notice Template ceiling for DEBT_CAP thresholds (raw reserve units). Terms above it are rejected
    ///         at open and stop adding weight if the ceiling is later lowered.
    uint256 public maxDebtCapThreshold = 1_000_000e6;
    /// @notice Template ceiling for NEGATIVE_PLEDGE thresholds (raw token units), same semantics.
    uint256 public maxPledgeThreshold = 1_000_000e6;

    // ------------------------------------------------------------------ state

    uint256 public nextLineId = 1;
    mapping(uint256 lineId => Line) internal _lines;
    mapping(uint256 lineId => Term[]) internal _terms;

    /// @notice First source height at which events can breach the line, per chain (latest attested + 1 at open).
    mapping(uint256 lineId => mapping(uint64 chainKey => uint64)) public activeFromHeight;
    /// @notice Aave pool snapshotted from the registry when the line was opened, per chain.
    mapping(uint256 lineId => mapping(uint64 chainKey => address)) public sourcePoolOf;
    /// @notice Asset of the last breach (debt reserve / pledged token). A DEBT_CAP cure must repay this reserve.
    mapping(uint256 lineId => address) public breachAssetOf;
    /// @notice The open (Active or Breached) line of a linked wallet, 0 if none.
    mapping(address wallet => uint256 lineId) public activeLineOf;
    /// @notice Consumed proofs: keccak256(abi.encode(uint64 chainKey, uint64 height, uint64 txIndex, uint256 logIndex)).
    mapping(bytes32 replayKey => bool) public usedReplayKeys;
    /// @notice Consumed proofs by content: keccak256(abi.encode(chainKey, height, keccak256(encodedTx), logIndex)).
    ///         Guards against the same log being presented under a second sibling path / tx index.
    mapping(bytes32 txLogKey => bool) public usedTxLogKeys;

    // ------------------------------------------------------------------ events

    event LineOpened(
        uint256 indexed lineId, address indexed borrower, address indexed linkedWallet, uint256 bond, bytes32 memoHash
    );
    event TermAttached(
        uint256 indexed lineId, uint8 indexed termIndex, uint8 kind, uint64 chainKey, address target, uint256 threshold
    );
    event SourceActivated(uint256 indexed lineId, uint64 indexed chainKey, uint64 activeFromHeight, address aavePool);
    event RepayProven(uint256 indexed lineId, uint64 indexed chainKey, bytes32 indexed replayKey, uint256 amount);
    event HistoryUpdated(uint256 indexed lineId, uint256 historyRepays, uint256 limit);
    event Drawn(uint256 indexed lineId, uint256 amount, uint256 principal);
    event Repaid(uint256 indexed lineId, address indexed payer, uint256 interestPaid, uint256 principalPaid);
    event CovenantBreached(
        uint256 indexed lineId, uint8 indexed termIndex, address indexed reporter, bytes32 replayKey, uint256 bounty
    );
    event GraceStarted(uint256 indexed lineId, uint64 breachHeight, uint256 breachAmount, uint40 graceEnds);
    event LineCured(uint256 indexed lineId, uint8 indexed termIndex, bool byProof, bytes32 replayKey);
    event LineDefaulted(
        uint256 indexed lineId,
        address indexed keeper,
        uint256 recovered,
        uint256 principalLoss,
        uint256 keeperReward,
        uint256 bondRefund
    );
    event LineClosed(uint256 indexed lineId, uint256 bondReturned);
    event ParameterUpdated(bytes32 indexed name, uint256 value);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error ZeroAmount();
    error AssetMismatch();
    error ParameterOutOfBounds();
    error InvalidTermCount();
    error InvalidTerm();
    error DuplicateTerm();
    error SourceNotRegistered(uint64 chainKey);
    error PledgeTokenNotAllowed(uint64 chainKey, address token);
    error ThresholdAboveCeiling();
    error ChainNotAttested(uint64 chainKey);
    error LinkSignatureExpired();
    error InvalidLinkSignature();
    error WalletHasActiveLine();
    error NotBorrower();
    error LineNotActive();
    error LineNotBreached();
    error ExceedsLimit();
    error NothingToRepay();
    error DebtOutstanding();
    error NoDebt();
    error TermIndexOutOfBounds();
    error TermRetired();
    error HeightBeforeActivation();
    error ProofAlreadyUsed(bytes32 key);
    error ProofInvalid();
    error PredicateFailed(CovenantPredicates.Reason reason);
    error GracePeriodOver();
    error GracePeriodActive();
    error NotCurableByProof();
    error CureHeightTooLow();
    error HistoryCapExceeded();
    error LengthMismatch();

    // ------------------------------------------------------------------ construction

    /// @param wctc Bond and pool asset.
    /// @param pool CovenantPool funding the lines (its asset must be `wctc`).
    /// @param creditRecord CreditRecord this manager writes to.
    /// @param owner_ Registry / parameter owner (two-step transferable). Has no access to funds.
    /// @dev Does not touch the precompiles, so it deploys on any EVM.
    constructor(IERC20 wctc, ICovenantPool pool, ICreditRecord creditRecord, address owner_)
        Ownable(owner_)
        EIP712("Covenant", "1")
    {
        if (address(wctc) == address(0) || address(pool) == address(0) || address(creditRecord) == address(0)) {
            revert ZeroAddress();
        }
        if (IERC4626(address(pool)).asset() != address(wctc)) revert AssetMismatch();
        VERIFIER = NativeQueryVerifierLib.getVerifier();
        CHAIN_INFO = IChainInfo(ChainInfoLib.PRECOMPILE);
        WCTC = wctc;
        POOL = pool;
        CREDIT_RECORD = creditRecord;
    }

    // ================================================================== borrower lifecycle

    /// @notice Opens a credit line: pulls the WCTC bond, attaches covenants, and binds `linkedWallet`.
    /// @param terms 1..8 covenants. No duplicate (kind, chainKey, target). `retired` must be false.
    /// @param bondAmount WCTC pulled from the caller (needs prior approval).
    /// @param linkedWallet Source-chain wallet the covenants watch; must sign the EIP-712 LinkWallet message.
    /// @param deadline Signature expiry (unix seconds).
    /// @param linkSig EIP-712 signature by `linkedWallet` over
    ///        LinkWallet(address borrower,address wallet,uint256 nonce,uint256 deadline), domain {"Covenant","1"}.
    /// @param memoHash Hash of the off-chain risk memo. Stored only; never affects limits or thresholds.
    /// @return lineId The new line id (starts at 1).
    function openLine(
        Term[] calldata terms,
        uint256 bondAmount,
        address linkedWallet,
        uint256 deadline,
        bytes calldata linkSig,
        bytes32 memoHash
    ) external nonReentrant returns (uint256 lineId) {
        if (block.timestamp > deadline) revert LinkSignatureExpired();
        bytes32 digest = linkWalletDigest(msg.sender, linkedWallet, _useNonce(linkedWallet), deadline);
        if (ECDSA.recover(digest, linkSig) != linkedWallet) revert InvalidLinkSignature();
        return _openLine(msg.sender, terms, bondAmount, linkedWallet, memoHash);
    }

    /// @notice Borrows `amount` WCTC from the pool against the line limit.
    /// @dev Borrower only, line Active. Accrues first; requires principal + amount <= limitOf(lineId).
    function draw(uint256 lineId, uint256 amount) external nonReentrant {
        Line storage line = _lines[lineId];
        if (msg.sender != line.borrower) revert NotBorrower();
        if (line.status != Status.Active) revert LineNotActive();
        if (amount == 0) revert ZeroAmount();
        _accrue(line);
        uint256 newPrincipal = line.principal + amount;
        if (newPrincipal > limitOf(lineId)) revert ExceedsLimit();
        line.principal = newPrincipal;
        emit Drawn(lineId, amount, newPrincipal);
        POOL.lend(line.borrower, amount);
    }

    /// @notice Repays up to `amount` (interest first, then principal). Anyone may repay any line.
    /// @dev Pulls WCTC from the caller straight into the pool. If the line is Breached and debt reaches
    ///      zero, the breach is cured (breached term retired). `amount` above the debt is not pulled.
    ///      A Breached line with no debt can be cured with `amount = 0`.
    function repay(uint256 lineId, uint256 amount) external nonReentrant {
        Line storage line = _lines[lineId];
        Status status = line.status;
        if (status != Status.Active && status != Status.Breached) revert LineNotActive();
        _accrue(line);

        uint256 interestPaid = Math.min(amount, line.interestAccrued);
        uint256 principalPaid = Math.min(amount - interestPaid, line.principal);
        uint256 paid = interestPaid + principalPaid;
        line.interestAccrued -= interestPaid;
        line.principal -= principalPaid;
        bool debtCleared = line.principal == 0 && line.interestAccrued == 0;
        bool cure = status == Status.Breached && debtCleared;
        if (paid == 0 && !cure) revert NothingToRepay();

        emit Repaid(lineId, msg.sender, interestPaid, principalPaid);
        if (cure) _markCured(lineId, line, false, bytes32(0));

        if (paid > 0) {
            WCTC.safeTransferFrom(msg.sender, address(POOL), paid);
            POOL.onRepay(principalPaid, interestPaid);
        }
        if (cure) CREDIT_RECORD.recordCure(line.linkedWallet);
    }

    /// @notice Closes a debt-free Active line and returns the bond to the borrower.
    function closeLine(uint256 lineId) external nonReentrant {
        Line storage line = _lines[lineId];
        if (msg.sender != line.borrower) revert NotBorrower();
        if (line.status != Status.Active) revert LineNotActive();
        _accrue(line);
        if (line.principal != 0 || line.interestAccrued != 0) revert DebtOutstanding();

        uint256 bond = line.bond;
        line.bond = 0;
        line.status = Status.Closed;
        delete activeLineOf[line.linkedWallet];

        emit LineClosed(lineId, bond);
        CREDIT_RECORD.recordKept(line.linkedWallet, line.historyRepays);
        WCTC.safeTransfer(line.borrower, bond);
    }

    // ================================================================== proven history

    /// @notice Proves one past Aave Repay by the linked wallet (+2500 bps limit boost, max 4 repays).
    /// @dev Permissionless (it only helps the borrower). Line must be Active and `chainKey` one of its chains.
    /// @param logIndex Tx-local receipt log index of the Aave `Repay` event.
    function proveRepay(
        uint256 lineId,
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTx,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof,
        uint256 logIndex
    ) external nonReentrant {
        (Line storage line, address sourcePool) = _historyPrecheck(lineId, chainKey, 1);
        _consumeRepay(lineId, line.linkedWallet, sourcePool, chainKey, height, encodedTx, merkleProof, logIndex);
        if (!VERIFIER.verifyAndEmit(chainKey, height, encodedTx, merkleProof, continuityProof)) revert ProofInvalid();
        _bumpHistory(lineId, line, 1);
    }

    /// @notice Batch variant of `proveRepay`, verified in one call to the precompile's batch overload.
    /// @param heights Source block heights, one per tx (same order as the batch proof).
    /// @param encodedTxs Prover `txBytes`, one per tx.
    /// @param merkleProofs Merkle proofs, one per tx.
    /// @param sharedContinuity Continuity proof covering all heights.
    /// @param logIndexes Tx-local receipt log index of the `Repay` event in each tx.
    function proveHistory(
        uint256 lineId,
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTxs,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        INativeQueryVerifier.ContinuityProof calldata sharedContinuity,
        uint256[] calldata logIndexes
    ) external nonReentrant {
        uint256 n = heights.length;
        if (n == 0 || encodedTxs.length != n || merkleProofs.length != n || logIndexes.length != n) {
            revert LengthMismatch();
        }
        (Line storage line, address sourcePool) = _historyPrecheck(lineId, chainKey, n);
        for (uint256 i; i < n; ++i) {
            _consumeRepay(
                lineId, line.linkedWallet, sourcePool, chainKey, heights[i], encodedTxs[i], merkleProofs[i], logIndexes[i]
            );
        }
        if (!VERIFIER.verifyAndEmit(chainKey, heights, encodedTxs, merkleProofs, sharedContinuity)) {
            revert ProofInvalid();
        }
        _bumpHistory(lineId, line, n);
    }

    // ================================================================== breach, cure, default

    /// @notice Proves a covenant breach. Permissionless; the caller earns `bountyBps` of the current bond.
    /// @dev Requires: line Active, term not retired, `height >= activeFromHeight[lineId][term.chainKey]`,
    ///      unused replay key, precompile verification, receipt status 1, emitter/topic/predicate match.
    ///      The chain key comes from the term, so a proof from another chain cannot satisfy it.
    /// @param termIndex Index into `termsOf(lineId)`.
    /// @param height Source block height of the proven tx.
    /// @param encodedTx Prover `txBytes`.
    /// @param logIndex Tx-local receipt log index of the breaching event.
    /// @return replayKey keccak256(abi.encode(uint64 chainKey, uint64 height, uint64 txIndex, uint256 logIndex)).
    function reportBreach(
        uint256 lineId,
        uint8 termIndex,
        uint64 height,
        bytes calldata encodedTx,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof,
        uint256 logIndex
    ) external nonReentrant returns (bytes32 replayKey) {
        Line storage line = _lines[lineId];
        if (line.status != Status.Active) revert LineNotActive();
        if (termIndex >= _terms[lineId].length) revert TermIndexOutOfBounds();
        Term memory term = _terms[lineId][termIndex];
        if (term.retired) revert TermRetired();
        if (height < activeFromHeight[lineId][term.chainKey]) revert HeightBeforeActivation();

        replayKey = _consumeProof(term.chainKey, height, encodedTx, merkleProof, logIndex);

        (CovenantPredicates.Reason reason, uint256 amount, address asset) = CovenantEvaluator.breach(
            term.kind,
            _breachEmitter(lineId, term),
            term.target,
            term.threshold,
            line.linkedWallet,
            encodedTx,
            logIndex
        );
        if (reason != CovenantPredicates.Reason.Ok) revert PredicateFailed(reason);
        if (!VERIFIER.verifyAndEmit(term.chainKey, height, encodedTx, merkleProof, continuityProof)) {
            revert ProofInvalid();
        }

        _accrue(line);
        uint256 bounty = line.bond * bountyBps / BPS;
        line.bond -= bounty;
        line.status = Status.Breached;
        line.breachedAt = uint40(block.timestamp);
        line.graceEnds = uint40(block.timestamp + gracePeriod);
        line.breachedTerm = termIndex;
        line.breachHeight = height;
        line.breachAmount = amount;
        breachAssetOf[lineId] = asset;

        emit CovenantBreached(lineId, termIndex, msg.sender, replayKey, bounty);
        emit GraceStarted(lineId, height, amount, line.graceEnds);
        CREDIT_RECORD.recordBreach(line.linkedWallet);
        if (bounty > 0) WCTC.safeTransfer(msg.sender, bounty);
    }

    /// @notice Cures a DEBT_CAP or NEGATIVE_PLEDGE breach within the grace period by proving it was undone.
    /// @dev DEBT_CAP: Aave Repay for the linked wallet of the breached reserve, amount >= breachAmount.
    ///      NEGATIVE_PLEDGE: Transfer of the pledged token into the linked wallet, value >= breachAmount.
    ///      Both need `height > breachHeight`. CROSS_DEFAULT can only be cured by full repayment.
    ///      Permissionless. On success the breached term is retired and the line is Active again.
    /// @param logIndex Tx-local receipt log index of the curing event.
    function cureByProof(
        uint256 lineId,
        uint64 height,
        bytes calldata encodedTx,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof,
        uint256 logIndex
    ) external nonReentrant returns (bytes32 replayKey) {
        Line storage line = _lines[lineId];
        if (line.status != Status.Breached) revert LineNotBreached();
        if (block.timestamp > line.graceEnds) revert GracePeriodOver();
        Term memory term = _terms[lineId][line.breachedTerm];
        if (term.kind == CROSS_DEFAULT) revert NotCurableByProof();
        if (height <= line.breachHeight) revert CureHeightTooLow();

        replayKey = _consumeProof(term.chainKey, height, encodedTx, merkleProof, logIndex);

        CovenantPredicates.Reason reason;
        if (term.kind == DEBT_CAP) {
            (reason,) = CovenantEvaluator.repay(
                encodedTx,
                logIndex,
                sourcePoolOf[lineId][term.chainKey],
                line.linkedWallet,
                term.target != address(0) ? term.target : breachAssetOf[lineId],
                line.breachAmount
            );
        } else {
            (reason,) =
                CovenantEvaluator.transferTo(encodedTx, logIndex, term.target, line.linkedWallet, line.breachAmount);
        }
        if (reason != CovenantPredicates.Reason.Ok) revert PredicateFailed(reason);
        if (!VERIFIER.verifyAndEmit(term.chainKey, height, encodedTx, merkleProof, continuityProof)) {
            revert ProofInvalid();
        }

        _markCured(lineId, line, true, replayKey);
        CREDIT_RECORD.recordCure(line.linkedWallet);
    }

    /// @notice Settles a Breached line after its grace period. Permissionless.
    /// @dev Keeper earns KEEPER_REWARD_BPS of the remaining bond. The rest repays principal, then interest;
    ///      unrecovered principal is written off in the pool (loss socialized to LPs). Bond left after the
    ///      debt is fully covered is refunded to the borrower.
    function settleDefault(uint256 lineId) external nonReentrant {
        Line storage line = _lines[lineId];
        if (line.status != Status.Breached) revert LineNotBreached();
        if (block.timestamp <= line.graceEnds) revert GracePeriodActive();
        _accrue(line);
        uint256 principal = line.principal;
        uint256 debt = principal + line.interestAccrued;
        if (debt == 0) revert NoDebt();

        uint256 bond = line.bond;
        uint256 keeperReward = bond * KEEPER_REWARD_BPS / BPS;
        uint256 available = bond - keeperReward;
        uint256 recovered = Math.min(available, debt);
        uint256 refund = available - recovered;
        uint256 principalRecovered = Math.min(recovered, principal);
        uint256 principalLoss = principal - principalRecovered;

        line.bond = 0;
        line.principal = 0;
        line.interestAccrued = 0;
        line.status = Status.Defaulted;
        delete activeLineOf[line.linkedWallet];

        emit LineDefaulted(lineId, msg.sender, recovered, principalLoss, keeperReward, refund);
        if (recovered > 0) {
            WCTC.safeTransfer(address(POOL), recovered);
            POOL.onRepay(principalRecovered, recovered - principalRecovered);
        }
        if (principalLoss > 0) POOL.writeOff(principalLoss);
        CREDIT_RECORD.recordDefault(line.linkedWallet);
        if (keeperReward > 0) WCTC.safeTransfer(msg.sender, keeperReward);
        if (refund > 0) WCTC.safeTransfer(line.borrower, refund);
    }

    // ================================================================== views

    /// @notice Current credit limit:
    ///         min(bond * (10000 + weights + historyBoost) / 10000, bond * maxLeverageBps / 10000, perLineCap).
    /// @dev Weights come from non-retired terms within the template ceilings, counted once per (kind, chainKey).
    function limitOf(uint256 lineId) public view returns (uint256) {
        Line storage line = _lines[lineId];
        uint256 bond = line.bond;
        if (bond == 0) return 0;
        uint256 multiplier = BPS + _termWeights(lineId) + uint256(line.historyRepays) * HISTORY_BOOST_PER_REPAY;
        uint256 byCovenants = bond * multiplier / BPS;
        uint256 byLeverage = bond * maxLeverageBps / BPS;
        return Math.min(Math.min(byCovenants, byLeverage), perLineCap);
    }

    /// @notice Principal plus interest accrued up to now.
    function debtOf(uint256 lineId) external view returns (uint256) {
        Line storage line = _lines[lineId];
        return line.principal + line.interestAccrued + _pendingInterest(line);
    }

    /// @notice All covenants of a line, including retired ones.
    function termsOf(uint256 lineId) external view returns (Term[] memory) {
        return _terms[lineId];
    }

    /// @notice Full line struct.
    function lineOf(uint256 lineId) external view returns (Line memory) {
        return _lines[lineId];
    }

    /// @notice EIP-712 digest the linked wallet signs to authorize `borrower`.
    function linkWalletDigest(address borrower, address wallet, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(LINK_WALLET_TYPEHASH, borrower, wallet, nonce, deadline)));
    }

    /// @notice Replay key for a proven log.
    function replayKeyOf(uint64 chainKey, uint64 height, uint64 txIndex, uint256 logIndex)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainKey, height, txIndex, logIndex));
    }

    /// @notice Dry run of `reportBreach` using the precompile's view `verify`. Never reverts on a failed check;
    ///         returns the first failing reason instead (reverts only if `encodedTx` is not decodable).
    /// @return breach True if `reportBreach` with the same arguments would succeed now.
    /// @return amount Breach amount decoded from the log (when decodable).
    /// @return reason Empty on success, otherwise a short explanation.
    function previewBreach(
        uint256 lineId,
        uint8 termIndex,
        uint64 height,
        bytes calldata encodedTx,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof,
        uint256 logIndex
    ) external view returns (bool breach, uint256 amount, string memory reason) {
        Line storage line = _lines[lineId];
        if (line.status != Status.Active) return (false, 0, "line not active");
        if (termIndex >= _terms[lineId].length) return (false, 0, "term index out of bounds");
        Term memory term = _terms[lineId][termIndex];
        if (term.retired) return (false, 0, "term retired");
        if (height < activeFromHeight[lineId][term.chainKey]) return (false, 0, "height before activation");

        try VERIFIER.calculateTxIndex(merkleProof) returns (uint64 txIndex) {
            if (
                usedReplayKeys[replayKeyOf(term.chainKey, height, txIndex, logIndex)]
                    || usedTxLogKeys[_txLogKey(term.chainKey, height, encodedTx, logIndex)]
            ) return (false, 0, "proof already used");
        } catch {
            return (false, 0, "proof invalid");
        }

        CovenantPredicates.Reason r;
        (r, amount,) = CovenantEvaluator.breach(
            term.kind, _breachEmitter(lineId, term), term.target, term.threshold, line.linkedWallet, encodedTx, logIndex
        );
        if (r != CovenantPredicates.Reason.Ok) return (false, amount, CovenantEvaluator.describe(r));

        try VERIFIER.verify(term.chainKey, height, encodedTx, merkleProof, continuityProof) returns (bool ok) {
            if (!ok) return (false, amount, "proof invalid");
        } catch {
            return (false, amount, "proof invalid");
        }
        return (true, amount, "");
    }

    /// @notice Decode-only predicate check (no proof, no line) against the current registry.
    /// @param kind Covenant kind.
    /// @param chainKey Source chain (selects the registered Aave pool).
    /// @param target DEBT_CAP reserve (0 = any) or NEGATIVE_PLEDGE token (must be allowlisted).
    /// @param threshold Amount to exceed.
    /// @param wallet Wallet the event must concern.
    /// @param encodedTx Prover `txBytes`.
    /// @param logIndex Tx-local receipt log index.
    function previewPredicate(
        uint8 kind,
        uint64 chainKey,
        address target,
        uint256 threshold,
        address wallet,
        bytes calldata encodedTx,
        uint256 logIndex
    ) external view returns (bool breach, uint256 amount, string memory reason) {
        address emitter;
        if (kind == NEGATIVE_PLEDGE) {
            if (!pledgeTokenAllowed[chainKey][target]) {
                return (false, 0, CovenantEvaluator.describe(CovenantPredicates.Reason.TokenNotAllowed));
            }
            emitter = target;
        } else if (kind == CROSS_DEFAULT || kind == DEBT_CAP) {
            emitter = aavePool[chainKey];
            if (emitter == address(0)) {
                return (false, 0, CovenantEvaluator.describe(CovenantPredicates.Reason.SourceNotRegistered));
            }
        } else {
            return (false, 0, CovenantEvaluator.describe(CovenantPredicates.Reason.UnknownKind));
        }
        CovenantPredicates.Reason r;
        (r, amount,) = CovenantEvaluator.breach(kind, emitter, target, threshold, wallet, encodedTx, logIndex);
        return (r == CovenantPredicates.Reason.Ok, amount, CovenantEvaluator.describe(r));
    }

    // ================================================================== owner parameters

    function setAprBps(uint256 value) external onlyOwner {
        if (value > MAX_APR_BPS) revert ParameterOutOfBounds();
        aprBps = value;
        emit ParameterUpdated("aprBps", value);
    }

    function setBountyBps(uint256 value) external onlyOwner {
        if (value > MAX_BOUNTY_BPS) revert ParameterOutOfBounds();
        bountyBps = value;
        emit ParameterUpdated("bountyBps", value);
    }

    function setGracePeriod(uint256 value) external onlyOwner {
        if (value < MIN_GRACE_PERIOD || value > MAX_GRACE_PERIOD) revert ParameterOutOfBounds();
        gracePeriod = value;
        emit ParameterUpdated("gracePeriod", value);
    }

    function setMaxLeverageBps(uint256 value) external onlyOwner {
        if (value < MIN_LEVERAGE_BPS || value > MAX_LEVERAGE_BPS) revert ParameterOutOfBounds();
        maxLeverageBps = value;
        emit ParameterUpdated("maxLeverageBps", value);
    }

    function setPerLineCap(uint256 value) external onlyOwner {
        if (value == 0) revert ParameterOutOfBounds();
        perLineCap = value;
        emit ParameterUpdated("perLineCap", value);
    }

    function setMaxDebtCapThreshold(uint256 value) external onlyOwner {
        maxDebtCapThreshold = value;
        emit ParameterUpdated("maxDebtCapThreshold", value);
    }

    function setMaxPledgeThreshold(uint256 value) external onlyOwner {
        maxPledgeThreshold = value;
        emit ParameterUpdated("maxPledgeThreshold", value);
    }

    // ================================================================== internals

    function _openLine(
        address borrower,
        Term[] calldata terms,
        uint256 bondAmount,
        address linkedWallet,
        bytes32 memoHash
    ) internal returns (uint256 lineId) {
        if (bondAmount == 0) revert ZeroAmount();
        if (linkedWallet == address(0)) revert ZeroAddress();
        if (activeLineOf[linkedWallet] != 0) revert WalletHasActiveLine();
        uint256 n = terms.length;
        if (n == 0 || n > MAX_TERMS) revert InvalidTermCount();

        lineId = nextLineId++;
        Term[] storage stored = _terms[lineId];
        for (uint256 i; i < n; ++i) {
            Term calldata t = terms[i];
            _validateTerm(t);
            for (uint256 j; j < i; ++j) {
                if (terms[j].kind == t.kind && terms[j].chainKey == t.chainKey && terms[j].target == t.target) {
                    revert DuplicateTerm();
                }
            }
            stored.push(t);
            emit TermAttached(lineId, uint8(i), t.kind, t.chainKey, t.target, t.threshold);
            if (activeFromHeight[lineId][t.chainKey] == 0) _activateChain(lineId, t.chainKey);
        }

        Line storage line = _lines[lineId];
        line.borrower = borrower;
        line.linkedWallet = linkedWallet;
        line.bond = bondAmount;
        line.lastAccrual = uint40(block.timestamp);
        line.status = Status.Active;
        line.memoHash = memoHash;
        activeLineOf[linkedWallet] = lineId;

        emit LineOpened(lineId, borrower, linkedWallet, bondAmount, memoHash);
        WCTC.safeTransferFrom(borrower, address(this), bondAmount);
    }

    function _validateTerm(Term calldata t) internal view {
        if (t.retired) revert InvalidTerm();
        if (t.kind == CROSS_DEFAULT) {
            if (t.target != address(0) || t.threshold != 0) revert InvalidTerm();
            if (aavePool[t.chainKey] == address(0)) revert SourceNotRegistered(t.chainKey);
        } else if (t.kind == DEBT_CAP) {
            if (aavePool[t.chainKey] == address(0)) revert SourceNotRegistered(t.chainKey);
            if (t.threshold > maxDebtCapThreshold) revert ThresholdAboveCeiling();
        } else if (t.kind == NEGATIVE_PLEDGE) {
            if (!pledgeTokenAllowed[t.chainKey][t.target]) revert PledgeTokenNotAllowed(t.chainKey, t.target);
            if (t.threshold > maxPledgeThreshold) revert ThresholdAboveCeiling();
        } else {
            revert InvalidTerm();
        }
    }

    /// @dev Events at or below the latest attested height when the line opens can never breach it.
    function _activateChain(uint256 lineId, uint64 chainKey) internal {
        IChainInfo.HeightHashResult memory latest = CHAIN_INFO.get_latest_attestation_height_and_hash(chainKey);
        if (!latest.exists) revert ChainNotAttested(chainKey);
        uint64 fromHeight = latest.height + 1;
        address sourcePool = aavePool[chainKey];
        activeFromHeight[lineId][chainKey] = fromHeight;
        sourcePoolOf[lineId][chainKey] = sourcePool;
        emit SourceActivated(lineId, chainKey, fromHeight, sourcePool);
    }

    function _accrue(Line storage line) internal {
        uint256 pending = _pendingInterest(line);
        if (pending > 0) line.interestAccrued += pending;
        line.lastAccrual = uint40(block.timestamp);
    }

    /// @dev Simple interest per second, rounded up so frequent accrual can never under-charge.
    function _pendingInterest(Line storage line) internal view returns (uint256) {
        uint256 principal = line.principal;
        if (principal == 0 || block.timestamp <= line.lastAccrual) return 0;
        return Math.mulDiv(principal * aprBps, block.timestamp - line.lastAccrual, BPS * YEAR, Math.Rounding.Ceil);
    }

    function _termWeights(uint256 lineId) internal view returns (uint256 sum) {
        Term[] storage ts = _terms[lineId];
        uint256 n = ts.length;
        for (uint256 i; i < n; ++i) {
            Term storage t = ts[i];
            if (!_countsForWeight(t)) continue;
            bool seen;
            for (uint256 j; j < i; ++j) {
                if (ts[j].kind == t.kind && ts[j].chainKey == t.chainKey && _countsForWeight(ts[j])) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;
            if (t.kind == CROSS_DEFAULT) sum += WEIGHT_CROSS_DEFAULT;
            else if (t.kind == DEBT_CAP) sum += WEIGHT_DEBT_CAP;
            else sum += WEIGHT_NEGATIVE_PLEDGE;
        }
    }

    function _countsForWeight(Term storage t) internal view returns (bool) {
        if (t.retired) return false;
        if (t.kind == DEBT_CAP) return t.threshold <= maxDebtCapThreshold;
        if (t.kind == NEGATIVE_PLEDGE) return t.threshold <= maxPledgeThreshold;
        return true;
    }

    function _breachEmitter(uint256 lineId, Term memory term) internal view returns (address) {
        return term.kind == NEGATIVE_PLEDGE ? term.target : sourcePoolOf[lineId][term.chainKey];
    }

    /// @dev Marks both the spec replay key and the content key used. Reverts if either was used before.
    function _consumeProof(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTx,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        uint256 logIndex
    ) internal returns (bytes32 replayKey) {
        replayKey = replayKeyOf(chainKey, height, VERIFIER.calculateTxIndex(merkleProof), logIndex);
        bytes32 txLogKey = _txLogKey(chainKey, height, encodedTx, logIndex);
        if (usedReplayKeys[replayKey]) revert ProofAlreadyUsed(replayKey);
        if (usedTxLogKeys[txLogKey]) revert ProofAlreadyUsed(txLogKey);
        usedReplayKeys[replayKey] = true;
        usedTxLogKeys[txLogKey] = true;
    }

    function _txLogKey(uint64 chainKey, uint64 height, bytes calldata encodedTx, uint256 logIndex)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainKey, height, keccak256(encodedTx), logIndex));
    }

    function _historyPrecheck(uint256 lineId, uint64 chainKey, uint256 count)
        internal
        view
        returns (Line storage line, address sourcePool)
    {
        line = _lines[lineId];
        if (line.status != Status.Active) revert LineNotActive();
        sourcePool = sourcePoolOf[lineId][chainKey];
        if (sourcePool == address(0)) revert SourceNotRegistered(chainKey);
        if (line.historyRepays + count > MAX_HISTORY_REPAYS) revert HistoryCapExceeded();
    }

    function _consumeRepay(
        uint256 lineId,
        address wallet,
        address sourcePool,
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTx,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        uint256 logIndex
    ) internal {
        bytes32 replayKey = _consumeProof(chainKey, height, encodedTx, merkleProof, logIndex);
        (CovenantPredicates.Reason reason, uint256 amount) =
            CovenantEvaluator.repay(encodedTx, logIndex, sourcePool, wallet, address(0), 0);
        if (reason != CovenantPredicates.Reason.Ok) revert PredicateFailed(reason);
        emit RepayProven(lineId, chainKey, replayKey, amount);
    }

    function _bumpHistory(uint256 lineId, Line storage line, uint256 count) internal {
        line.historyRepays += uint16(count);
        emit HistoryUpdated(lineId, line.historyRepays, limitOf(lineId));
    }

    function _markCured(uint256 lineId, Line storage line, bool byProof, bytes32 replayKey) internal {
        uint8 termIndex = line.breachedTerm;
        _terms[lineId][termIndex].retired = true;
        line.status = Status.Active;
        emit LineCured(lineId, termIndex, byProof, replayKey);
    }
}
