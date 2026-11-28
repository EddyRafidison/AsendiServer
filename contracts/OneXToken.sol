// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OneX Token (XTU)
/// @notice Fixed-supply BEP-20-compatible token with no contract-level transfer commission.
/// @dev The initial supply belongs to the Hot Wallet. TransferWithFee is retained as a zero-fee audit event for scanner compatibility.
contract OneXToken is ERC20 {
    uint256 public constant MAX_SUPPLY = 100_000_000_000 * 10 ** 18;
    uint256 public constant TRANSFER_FEE_BPS = 0;
    address public immutable initialWallet;
    address public immutable feeCollector;

    event TransferWithFee(
        address indexed from,
        address indexed to,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount,
        bool feeExempt
    );
    event FeeCollected(address indexed from, address indexed collector, uint256 amount);

    error InvalidWalletConfiguration();

    constructor(address hotWallet, address distributionWallet) ERC20("OneX Token", "XTU") {
        if (
            hotWallet == address(0) || distributionWallet == address(0) ||
            hotWallet == distributionWallet
        ) revert InvalidWalletConfiguration();

        initialWallet = hotWallet;
        feeCollector = distributionWallet;
        _mint(hotWallet, MAX_SUPPLY);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        // No fee is charged or redirected for any transfer. The legacy-shaped
        // event remains solely to make gross/net/fee reconciliation explicit.
        if (from != address(0) && to != address(0)) {
            emit TransferWithFee(from, to, value, value, 0, false);
        }
    }
}
