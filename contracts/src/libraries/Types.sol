// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Covenant kinds (`Term.kind`).
// CROSS_DEFAULT: Aave V3 LiquidationCall on the borrower's linked wallet.
uint8 constant CROSS_DEFAULT = 0;
// DEBT_CAP: Aave V3 Borrow on behalf of the linked wallet above `threshold` (optionally for reserve `target`).
uint8 constant DEBT_CAP = 1;
// NEGATIVE_PLEDGE: ERC-20 Transfer of allowlisted token `target` out of the linked wallet above `threshold`.
uint8 constant NEGATIVE_PLEDGE = 2;

/// @notice Lifecycle of a credit line.
enum Status {
    None,
    Active,
    Breached,
    Defaulted,
    Closed
}

/// @notice One covenant attached to a line.
/// @param kind One of CROSS_DEFAULT, DEBT_CAP, NEGATIVE_PLEDGE.
/// @param chainKey Attestcoin chain key of the source chain the covenant watches.
/// @param target DEBT_CAP: reserve (0 = any). NEGATIVE_PLEDGE: token. CROSS_DEFAULT: must be 0.
/// @param threshold Raw amount that must be exceeded to breach. CROSS_DEFAULT: must be 0.
/// @param retired Set when a breach of this term was cured; retired terms add no weight and cannot breach.
struct Term {
    uint8 kind;
    uint64 chainKey;
    address target;
    uint256 threshold;
    bool retired;
}

/// @notice A covenant-backed credit line.
struct Line {
    address borrower;
    address linkedWallet;
    uint256 bond;
    uint256 principal;
    uint256 interestAccrued;
    uint40 lastAccrual;
    uint16 historyRepays;
    Status status;
    uint40 breachedAt;
    uint40 graceEnds;
    uint8 breachedTerm;
    uint64 breachHeight;
    uint256 breachAmount;
    bytes32 memoHash; // hash of the off-chain risk memo (advisory only, never read by logic)
}
