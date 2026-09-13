// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WCTC
/// @notice WETH9-style wrapper for native tCTC. 1 WCTC is always backed by 1 native tCTC held here.
/// @dev Used as the asset of the Covenant lending pool and for borrower bonds.
contract WCTC is ERC20 {
    /// @notice Native value sent to `to` could not be delivered.
    error NativeTransferFailed();

    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() ERC20("Wrapped CTC", "WCTC") {}

    /// @notice Wraps native tCTC sent directly to the contract.
    receive() external payable {
        deposit();
    }

    /// @notice Wraps `msg.value` native tCTC into WCTC for the caller.
    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    /// @notice Burns `amount` WCTC from the caller and sends the same amount of native tCTC back.
    /// @param amount Amount to unwrap (18 decimals).
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
