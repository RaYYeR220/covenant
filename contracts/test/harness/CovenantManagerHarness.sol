// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CovenantManager} from "../../src/CovenantManager.sol";
import {ICovenantPool} from "../../src/interfaces/ICovenantPool.sol";
import {ICreditRecord} from "../../src/interfaces/ICreditRecord.sol";
import {Term} from "../../src/libraries/Types.sol";

/// @dev Test-only: opens a line for a wallet whose private key the tests do not hold (real source-chain
///      wallets from the fixtures). Everything after the signature check is the production path.
contract CovenantManagerHarness is CovenantManager {
    constructor(IERC20 wctc, ICovenantPool pool, ICreditRecord creditRecord, address owner_)
        CovenantManager(wctc, pool, creditRecord, owner_)
    {}

    function openLineUnsigned(
        address borrower,
        Term[] calldata terms,
        uint256 bondAmount,
        address linkedWallet,
        bytes32 memoHash
    ) external returns (uint256) {
        return _openLine(borrower, terms, bondAmount, linkedWallet, memoHash);
    }
}
