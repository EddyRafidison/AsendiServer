// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OneX Token (XTU)
/// @notice Fixed-supply BEP-20-compatible token with a mandatory 0.1% external-transfer fee.
/// @dev The initial supply belongs to the Hot Wallet. Only Hot Wallet -> Distribution Wallet is exempt.
contract OneXToken is ERC20 {
    uint256 public constant MAX_SUPPLY = 100_000_000_000 * 10 ** 18;
    uint256 public constant TRANSFER_FEE_BPS = 10;
    uint256 private constant BPS_DENOMINATOR = 10_000;

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
        // Mint and burn are not externally initiated token transfers.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        // The only exemption is the exact internal consolidation pair.
        bool feeExempt = from == initialWallet && to == feeCollector;
        uint256 fee = feeExempt || value == 0
            ? 0
            : (value * TRANSFER_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netAmount = value - fee;

        super._update(from, to, netAmount);

        if (fee > 0) {
            // If Distribution Wallet sends, its commission remains in its own balance.
            // No self-transfer is emitted or executed in that case.
            if (from != feeCollector) {
                super._update(from, feeCollector, fee);
                emit FeeCollected(from, feeCollector, fee);
            }
        }

        emit TransferWithFee(from, to, value, netAmount, fee, feeExempt);
    }
}
