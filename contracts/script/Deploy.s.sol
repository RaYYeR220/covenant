// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {WCTC} from "../src/WCTC.sol";
import {CovenantPool} from "../src/CovenantPool.sol";
import {CreditRecord} from "../src/CreditRecord.sol";
import {CovenantManager} from "../src/CovenantManager.sol";

/// @notice Deploys Covenant to Creditcoin CC3 testnet (chainId 102031) and wires it up.
/// @dev Usage:
///        forge script script/Deploy.s.sol --rpc-url https://rpc.cc3-testnet.creditcoin.network \
///          --private-key $DEPLOYER_PRIVATE_KEY --broadcast
///      The linked CovenantEvaluator library is deployed automatically by forge. Nothing here calls the
///      0x0FD2 / 0x0FD3 precompiles, so the same script simulates on anvil. Addresses are written to
///      deployments/creditcoin-testnet.json (or deployments/<chainId>.json on other chains).
contract Deploy is Script {
    uint256 internal constant CREDITCOIN_TESTNET = 102_031;

    uint64 internal constant SEPOLIA = 1;
    uint64 internal constant MAINNET = 3;
    address internal constant AAVE_POOL_MAINNET = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant AAVE_POOL_SEPOLIA = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address internal constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    /// @dev Aave V3 Sepolia market's own USDC reserve (faucet-mintable), used by the live testnet demo.
    address internal constant AAVE_USDC_SEPOLIA = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;

    struct Deployment {
        address wctc;
        address pool;
        address creditRecord;
        address manager;
        address evaluator;
    }

    function run() external returns (Deployment memory d) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        WCTC wctc = new WCTC();
        CovenantPool pool = new CovenantPool(IERC20(address(wctc)), deployer);
        CreditRecord record = new CreditRecord(deployer);
        CovenantManager manager = new CovenantManager(IERC20(address(wctc)), pool, record, deployer);

        pool.setManager(address(manager));
        record.setManager(address(manager));

        manager.setAavePool(MAINNET, AAVE_POOL_MAINNET);
        manager.setAavePool(SEPOLIA, AAVE_POOL_SEPOLIA);
        manager.setPledgeToken(MAINNET, USDC_MAINNET, true);
        manager.setPledgeToken(SEPOLIA, USDC_SEPOLIA, true);
        manager.setPledgeToken(SEPOLIA, AAVE_USDC_SEPOLIA, true);
        vm.stopBroadcast();

        d = Deployment({
            wctc: address(wctc),
            pool: address(pool),
            creditRecord: address(record),
            manager: address(manager),
            evaluator: _linkedEvaluator(address(manager))
        });
        _check(d, deployer);
        _write(d, deployer);
    }

    /// @dev Reads the CovenantEvaluator address forge linked into the manager's runtime code.
    function _linkedEvaluator(address manager) internal view returns (address lib) {
        string memory artifact = vm.readFile("out/CovenantManager.sol/CovenantManager.json");
        uint256 start = vm.parseJsonUint(
            artifact,
            ".deployedBytecode.linkReferences['src/libraries/CovenantEvaluator.sol'].CovenantEvaluator[0].start"
        );
        bytes memory code = manager.code;
        uint256 word;
        assembly {
            word := mload(add(add(code, 32), start))
        }
        lib = address(uint160(word >> 96));
    }

    function _check(Deployment memory d, address deployer) internal view {
        CovenantPool pool = CovenantPool(d.pool);
        CovenantManager manager = CovenantManager(d.manager);
        require(pool.manager() == d.manager, "pool not wired");
        require(CreditRecord(d.creditRecord).manager() == d.manager, "record not wired");
        require(pool.asset() == d.wctc, "pool asset");
        require(manager.owner() == deployer && pool.owner() == deployer, "owner");
        require(manager.aavePool(MAINNET) == AAVE_POOL_MAINNET, "aave mainnet");
        require(manager.aavePool(SEPOLIA) == AAVE_POOL_SEPOLIA, "aave sepolia");
        require(manager.pledgeTokenAllowed(MAINNET, USDC_MAINNET), "usdc mainnet");
        require(manager.pledgeTokenAllowed(SEPOLIA, USDC_SEPOLIA), "usdc sepolia");
        require(d.evaluator.code.length > 0, "evaluator not deployed");
    }

    function _write(Deployment memory d, address deployer) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "WCTC", d.wctc);
        vm.serializeAddress(k, "CovenantPool", d.pool);
        vm.serializeAddress(k, "CreditRecord", d.creditRecord);
        vm.serializeAddress(k, "CovenantEvaluator", d.evaluator);
        vm.serializeAddress(k, "NativeQueryVerifier", 0x0000000000000000000000000000000000000FD2);
        vm.serializeAddress(k, "ChainInfo", 0x0000000000000000000000000000000000000fD3);
        vm.serializeAddress(k, "AavePoolMainnet", AAVE_POOL_MAINNET);
        vm.serializeAddress(k, "AavePoolSepolia", AAVE_POOL_SEPOLIA);
        vm.serializeAddress(k, "UsdcMainnet", USDC_MAINNET);
        vm.serializeAddress(k, "UsdcSepolia", USDC_SEPOLIA);
        string memory json = vm.serializeAddress(k, "CovenantManager", d.manager);

        string memory path = block.chainid == CREDITCOIN_TESTNET
            ? "deployments/creditcoin-testnet.json"
            : string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console.log("WCTC              ", d.wctc);
        console.log("CovenantPool      ", d.pool);
        console.log("CreditRecord      ", d.creditRecord);
        console.log("CovenantEvaluator ", d.evaluator);
        console.log("CovenantManager   ", d.manager);
        console.log("written to", path);
    }
}
