
/**
 * Copyright (c) 2018-present, Leap DAO (leapdao.org)
 *
 * This source code is licensed under the Mozilla Public License, version 2,
 * found in the LICENSE file in the root directory of this source tree.
 */

/* solium-disable security/no-block-members */

pragma solidity 0.5.2;

import "../node_modules/openzeppelin-solidity/contracts/math/Math.sol";

import "./DepositHandler.sol";
import "./IExitHandler.sol";
import "./Bridge.sol";
import "./TxLib.sol";
import "./PriorityQueue.sol";

contract ExitHandler is IExitHandler, DepositHandler {

  using PriorityQueue for PriorityQueue.Token;

  event ExitStarted(
    bytes32 indexed txHash,
    uint8 indexed outIndex,
    uint256 indexed color,
    address exitor,
    uint256 amount,
    bytes32 periodRoot
  );

  /**
    - tokenData — (optional) NST data
   */
  struct Exit {
    uint256 amount;
    uint16 color;
    address owner;
    bool finalized;
    uint32 priorityTimestamp;
    uint256 stake;
    bytes32 tokenData;
  }

  uint256 public exitDuration;
  uint256 public exitStake;
  uint256 public nftExitCounter;
  uint256 public nstExitCounter;

  /**
   * UTXO → Exit mapping
   */
  mapping(bytes32 => Exit) exitMapping;
  mapping(bytes32 => bytes32) exitRoots;

  function exits(bytes32 _utxoId) public view returns (
    uint256 amount,
    uint16 color,
    address owner,
    bool finalized,
    uint32 priorityTimestamp,
    uint256 stake,
    bytes32 tokenData,
    bytes32 periodRoot
  ) {
    Exit memory exit = exitMapping[_utxoId];
    bytes32 periodRoot = exitRoots[_utxoId];
    return (
      exit.amount,
      exit.color,
      exit.owner,
      exit.finalized,
      exit.priorityTimestamp,
      exit.stake,
      exit.tokenData,
      periodRoot
    );
  }

  function initializeWithExit(
    Bridge _bridge,
    uint256 _exitDuration,
    uint256 _exitStake) public initializer {
    initialize(_bridge);
    exitDuration = _exitDuration;
    exitStake = _exitStake;
    emit MinGasPrice(0);
  }

  function setExitStake(uint256 _exitStake) public ifAdmin {
    exitStake = _exitStake;
  }

  function setExitDuration(uint256 _exitDuration) public ifAdmin {
    exitDuration = _exitDuration;
  }

  struct ProofResults {
    bytes32 txHash;
    bytes txData;
    uint64 txPos;
  }

  function startExit(
    bytes32[] memory _youngestInputProof, bytes32[] memory _proof,
    uint8 _outputIndex, uint8 _inputIndex
  ) public payable {
    require(msg.value >= exitStake, "Not enough ether sent to pay for exit stake");
    uint32 timestamp;
    (, timestamp,,) = bridge.periods(_proof[0]);
    require(timestamp > 0, "The referenced period was not submitted to bridge");

    if (_youngestInputProof.length > 0) {
      (, timestamp,,) = bridge.periods(_youngestInputProof[0]);
      require(timestamp > 0, "The referenced period was not submitted to bridge");
    }

    // check exiting tx inclusion in the root chain block
    ProofResults memory pr;
    (pr.txPos, pr.txHash, pr.txData) = TxLib.validateProof(32 * (_youngestInputProof.length + 2) + 64, _proof);

    // parse exiting tx and check if it is exitable
    TxLib.Tx memory exitingTx = TxLib.parseTx(pr.txData);
    TxLib.Output memory out = exitingTx.outs[_outputIndex];

    bytes32 utxoId = bytes32(uint256(_outputIndex) << 120 | uint120(uint256(pr.txHash)));
    uint256 priority;
    if (msg.sender != out.owner) {
      // or caller code hashes to owner
      address a = msg.sender;
      assembly {
        priority := extcodehash(a) // abusing priority for hashBytes here, to save stack
      }
      require(priority != 0, "caller not contract");
      require(bytes20(out.owner) == ripemd160(abi.encode(priority)), "Only UTXO owner or contract can start exit");
      out.owner = msg.sender;
    }
    require(out.value > 0, "UTXO has no value");
    require(exitMapping[utxoId].amount == 0, "The exit for UTXO has already been started");
    require(!exitMapping[utxoId].finalized, "The exit for UTXO has already been finalized");

    if (_youngestInputProof.length > 0) {
      // check youngest input tx inclusion in the root chain block
      bytes32 inputTxHash;
      (pr.txPos, inputTxHash,) = TxLib.validateProof(96, _youngestInputProof);
      require(
        inputTxHash == exitingTx.ins[_inputIndex].outpoint.hash,
        "Input from the proof is not referenced in exiting tx"
      );

      if (isNft(out.color)) {
        priority = (nftExitCounter << 128) | uint128(uint256(utxoId));
        nftExitCounter++;
      } else if (isNST(out.color)) {
        priority = (nstExitCounter << 128) | uint128(uint256(utxoId));
        nstExitCounter++;
      } else {
        priority = getERC20ExitPriority(timestamp, utxoId, pr.txPos);
      }
    } else {
      require(exitingTx.txType == TxLib.TxType.Deposit, "Expected deposit tx");
      if (isNft(out.color)) {
        priority = (nftExitCounter << 128) | uint128(uint256(utxoId));
        nftExitCounter++;
      } else if (isNST(out.color)) {
        priority = (nstExitCounter << 128) | uint128(uint256(utxoId));
        nstExitCounter++;
      } else {
        priority = getERC20ExitPriority(timestamp, utxoId, pr.txPos);
      }
    }

    tokens[out.color].insert(priority);

    exitMapping[utxoId] = Exit({
      owner: out.owner,
      color: out.color,
      amount: out.value,
      finalized: false,
      stake: exitStake,
      priorityTimestamp: timestamp,
      tokenData: out.stateRoot
    });
    exitRoots[utxoId] = _proof[0];

    emit ExitStarted(
      pr.txHash,
      _outputIndex,
      out.color,
      out.owner,
      out.value,
      _proof[0]
    );
  }

  function startDepositExit(uint256 _depositId) public payable {
    require(msg.value >= exitStake, "Not enough ether sent to pay for exit stake");
    // check that deposit exits
    Deposit memory deposit = deposits[uint32(_depositId)];
    require(deposit.owner == msg.sender, "Only deposit owner can start exit");
    require(deposit.amount > 0, "deposit has no value");
    require(exitMapping[bytes32(_depositId)].amount == 0, "The exit of deposit has already been started");
    require(!exitMapping[bytes32(_depositId)].finalized, "The exit for deposit has already been finalized");

    uint256 priority;
    if (isNft(deposit.color)) {
      priority = (nftExitCounter << 128) | uint128(_depositId);
      nftExitCounter++;
    } else if (isNST(deposit.color)) {
      priority = (nstExitCounter << 128) | uint128(_depositId);
      nstExitCounter++;
    } else {
      priority = getERC20ExitPriority(uint32(deposit.time), bytes32(_depositId), 0);
    }

    tokens[deposit.color].insert(priority);

    exitMapping[bytes32(_depositId)] = Exit({
      owner: deposit.owner,
      color: deposit.color,
      amount: deposit.amount,
      finalized: false,
      stake: exitStake,
      priorityTimestamp: uint32(now),
      tokenData: "0x"
    });

    // no need to emit ExitStartedV2
    // no need to update emit data root for NSTs, as it only got deposit now.
    emit ExitStarted(
      bytes32(_depositId),
      0,
      deposit.color,
      deposit.owner,
      deposit.amount,
      0
    );
  }

  // @dev Finalizes exit for the chosen color with the highest priority
  function finalizeExits(uint16 _color) public {
    bytes32 utxoId;
    uint256 exitableAt;
    Exit memory currentExit;

    (utxoId, exitableAt) = getNextExit(_color);

    require(tokens[_color].currentSize > 0, "Queue empty for color.");

    for (uint i = 0; i < 20; i++) {
      // if queue is empty or top exit cannot be exited yet, stop
      if (exitableAt > block.timestamp) {
        return;
      }

      currentExit = exitMapping[utxoId];

      // exits of deleted periods are not payed out but simply deleted
      if (exitRoots[utxoId] > 0) {
        uint32 timestamp;
        (, timestamp,,) = bridge.periods(exitRoots[utxoId]);
        if (timestamp == 0) {
          // stake goes to governance contract
          address(uint160(bridge.admin())).send(currentExit.stake);
          tokens[currentExit.color].delMin();
          exitMapping[utxoId].finalized = true;
          return;
        }
      }

      if (currentExit.owner != address(0) || currentExit.amount != 0) { // exit was not removed
        // Note: for NFTs, the amount is actually the NFT id (both uint256)
        if (isNft(currentExit.color)) {
          tokens[currentExit.color].addr.transferFrom(address(this), currentExit.owner, currentExit.amount);
        } else if (isNST(currentExit.color)) {
          bytes32 tokenData = currentExit.tokenData;
          address tokenAddr = address(tokens[currentExit.color].addr);

          bool success;
          (success, ) = tokenAddr.call(abi.encodeWithSignature("writeData(uint256,bytes32)", currentExit.amount, tokenData));
          // if set data did not work, we assume the token hasn't been minted yet
          if (!success) {
            tokenAddr.call(
              abi.encodeWithSignature(
                "breed(uint256,address,bytes32)",
                currentExit.amount, currentExit.owner, tokenData
              )
            );
          } else {
            // only if we were able to setData we try to transfer
            tokens[currentExit.color].addr.transferFrom(address(this), currentExit.owner, currentExit.amount);
          }
        } else {
          // why so complicated? why not transfer()?
          tokens[currentExit.color].addr.approve(address(this), currentExit.amount);
          tokens[currentExit.color].addr.transferFrom(address(this), currentExit.owner, currentExit.amount);
        }
        // Pay exit stake
        address(uint160(currentExit.owner)).send(currentExit.stake);
      }

      tokens[currentExit.color].delMin();
      exitMapping[utxoId].finalized = true;

      if (tokens[currentExit.color].currentSize > 0) {
        (utxoId, exitableAt) = getNextExit(_color);
      } else {
        return;
      }
    }
  }

  // @dev For backwards compatibility reasons...
  function finalizeTopExit(uint16 _color) public {
    finalizeExits(_color);
  }

  function challengeExit(
    bytes32[] memory _proof,
    bytes32[] memory _prevProof,
    uint8 _outputIndex,
    uint8 _inputIndex,
    address challenger
  ) public {
    require(msg.sender == challenger, "Wrong challenger");
    uint32 timestamp;
    if (_prevProof.length > 0) {
      // check period for _prevProof
      (, timestamp,,) = bridge.periods(_prevProof[0]);
      require(timestamp > 0, "The referenced period was not submitted to bridge");
    }
    // validate exiting tx
    uint256 offset = 32 * (_proof.length + 2);
    bytes32 txHash1;
    bytes memory txData;
    (, txHash1, txData) = TxLib.validateProof(offset + 96, _prevProof);
    bytes32 utxoId = bytes32(uint256(_outputIndex) << 120 | uint120(uint256(txHash1)));

    TxLib.Tx memory txn;
    if (_proof.length > 0) {
      // check period for _proof
      (, timestamp,,) = bridge.periods(_proof[0]);
      require(timestamp > 0, "The referenced period was not submitted to bridge");
      // validate spending tx
      bytes32 txHash;
      (, txHash, txData) = TxLib.validateProof(128, _proof);
      txn = TxLib.parseTx(txData);

      // make sure one is spending the other one
      require(txHash1 == txn.ins[_inputIndex].outpoint.hash, "prevout check failed on hash");
      require(_outputIndex == txn.ins[_inputIndex].outpoint.pos, "prevout check failed on pos");

      // if transfer, make sure signature correct
      if (txn.txType == TxLib.TxType.Transfer) {
        bytes32 sigHash = TxLib.getSigHash(txData);
        address signer = ecrecover(
          sigHash,
          txn.ins[_inputIndex].v,
          txn.ins[_inputIndex].r,
          txn.ins[_inputIndex].s
        );
        require(exitMapping[utxoId].owner == signer, "signer does not match");
      } else if (txn.txType == TxLib.TxType.SpendCond) { // solium-disable-line whitespace
        // check that hash of contract matches output address
        // just have the pass through
        // later we will check solEVM Enforcer here.
      } else {
        revert("unknown tx type");
      }
    } else {
      // challenging deposit exit
      txn = TxLib.parseTx(txData);
      utxoId = txn.ins[_inputIndex].outpoint.hash;
      if (txn.txType == TxLib.TxType.Deposit) {
        // check that deposit was included correctly
        // only then it should be usable for challenge
        Deposit memory deposit = deposits[uint32(uint256(utxoId))];
        require(deposit.amount == txn.outs[0].value, "value mismatch");
        require(deposit.owner == txn.outs[0].owner, "owner mismatch");
        require(deposit.color == txn.outs[0].color, "color mismatch");
        if (isNST(deposit.color)) {
          require(tokenData[uint32(uint256(utxoId))] == txn.outs[0].stateRoot, "data mismatch");
        }
        // todo: check timely inclusion of deposit tx
        // this will prevent grieving attacks by the operator
      } else {
        revert("unexpected tx type");
      }
    }

    require(exitMapping[utxoId].amount > 0, "exit not found");
    require(!exitMapping[utxoId].finalized, "The exit has already been finalized");

    // award stake to challanger
    msg.sender.transfer(exitMapping[utxoId].stake);
    // delete invalid exit
    delete exitMapping[utxoId];
  }

  function challengeYoungestInput(
    bytes32[] memory _youngerInputProof,
    bytes32[] memory _exitingTxProof,
    uint8 _outputIndex,
    uint8 _inputIndex,
    address challenger
  ) public {
    require(msg.sender == challenger, "Wrong challenger");
    // validate exiting input tx
    bytes32 txHash;
    bytes memory txData;
    (, txHash, txData) = TxLib.validateProof(32 * (_youngerInputProof.length + 2) + 96, _exitingTxProof);
    bytes32 utxoId = bytes32(uint256(_outputIndex) << 120 | uint120(uint256(txHash)));

    // check the exit exists
    require(exitMapping[utxoId].amount > 0, "There is no exit for this UTXO");

    TxLib.Tx memory exitingTx = TxLib.parseTx(txData);

    // validate younger input tx
    (,txHash,) = TxLib.validateProof(128, _youngerInputProof);

    // check younger input is actually an input of exiting tx
    require(txHash == exitingTx.ins[_inputIndex].outpoint.hash, "Given output is not referenced in exiting tx");

    uint32 youngerInputTimestamp;
    (,youngerInputTimestamp,,) = bridge.periods(_youngerInputProof[0]);
    require(youngerInputTimestamp > 0, "The referenced period was not submitted to bridge");

    require(exitMapping[utxoId].priorityTimestamp < youngerInputTimestamp, "Challenged input should be older");

    // award stake to challanger
    msg.sender.transfer(exitMapping[utxoId].stake);
    // delete invalid exit
    delete exitMapping[utxoId];
  }

  function getNextExit(uint16 _color) internal view returns (bytes32 utxoId, uint256 exitableAt) {
    uint256 priority = tokens[_color].getMin();
    utxoId = bytes32(uint256(uint128(priority)));
    exitableAt = priority >> 192;
  }

  function isNft(uint16 _color) internal pure returns (bool) {
    return (_color >= NFT_FIRST_COLOR) && (_color < NST_FIRST_COLOR);
  }

  function isNST(uint16 _color) internal pure returns (bool) {
    return _color >= NST_FIRST_COLOR;
  }

  function getERC20ExitPriority(
    uint32 timestamp, bytes32 utxoId, uint64 txPos
  ) internal view returns (uint256 priority) {
    uint256 exitableAt = Math.max(timestamp + (2 * exitDuration), block.timestamp + exitDuration);
    return (exitableAt << 192) | uint256(txPos) << 128 | uint128(uint256(utxoId));
  }

  // solium-disable-next-line mixedcase
  uint256[48] private ______gap;
}
