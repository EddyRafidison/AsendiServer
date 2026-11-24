// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OneX Token (XTU)
/// @notice Fixed-supply BEP-20-compatible ERC-20 token with a mandatory 0.1% transfer fee.
/// @dev The constructor mints the entire supply to the immutable distribution wallet.
contract OneXToken is ERC20 {
    uint256 public constant MAX_SUPPLY = 100_000_000_000 * 10 ** 18;
    uint256 public constant TRANSFER_FEE_BPS = 10;
    address public immutable feeCollector;

    event FeeCollected(address indexed from, address indexed collector, uint256 amount);

    error InvalidDistributionWallet();

    constructor(address distributionWallet) ERC20("OneX Token", "XTU") {
        if (distributionWallet == address(0)) revert InvalidDistributionWallet();
        feeCollector = distributionWallet;
        _mint(distributionWallet, MAX_SUPPLY);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Minting and burning remain fee-free. The public contract exposes no additional mint or burn function.
        if (from == address(0) || to == address(0) || value == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * TRANSFER_FEE_BPS) / 10_000;
        uint256 recipientAmount = value - fee;

        // The fee collector is also the distribution wallet. When it sends tokens,
        // the fee is retained in its own balance instead of creating a self-transfer.
        super._update(from, to, recipientAmount);
        if (fee > 0) {
            if (from != feeCollector) {
                super._update(from, feeCollector, fee);
            }
            emit FeeCollected(from, feeCollector, fee);
        }
    }
}
