
/**
 * Copyright (c) 2018-present, Leap DAO (leapdao.org)
 *
 * This source code is licensed under the Mozilla Public License, version 2,
 * found in the LICENSE file in the root directory of this source tree.
 */

pragma solidity 0.4.24;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";

import "./MintableToken.sol";

contract Bridge is Ownable {

  using SafeMath for uint256;

  modifier onlyOperator() {
    require(msg.sender == operator, "Tried to call a only-operator function from non-operator");
    _;
  }

  event NewHeight(uint256 height, bytes32 indexed root);
  event NewOperator(address operator);

  struct Period {
    bytes32 parent; // the id of the parent node
    uint32 height;  // the height of last block in period
    uint32 parentIndex; //  the position of this node in the Parent's children list
    uint32 timestamp;
    bytes32[] children; // unordered list of children below this node
  }

  bytes32 public constant GENESIS = 0x4920616d207665727920616e6772792c20627574206974207761732066756e21;

  uint256 public genesisBlockNumber; 
  bytes32 public tipHash; // hash of first period that has extended chain to some height
  uint256 public parentBlockInterval; // how often epochs can be submitted max
  uint64 public lastParentBlock; // last ethereum block when epoch was submitted
  address public operator; // the operator contract
  address public exitHandler; // the exit handler contract
  uint256 public maxReward; // max reward per period
  MintableToken public nativeToken; // plasma native token

  mapping(bytes32 => Period) public periods;

  constructor(
    uint256 _parentBlockInterval,
    uint256 _maxReward,
    MintableToken _nativeToken
  ) public {
    // init genesis preiod
    Period memory genesisPeriod = Period({
      parent: GENESIS,
      height: 1,
      timestamp: uint32(block.timestamp),
      parentIndex: 0,
      children: new bytes32[](0)
    });
    tipHash = GENESIS;
    periods[tipHash] = genesisPeriod;
    genesisBlockNumber = block.number;

    parentBlockInterval = _parentBlockInterval;
    lastParentBlock = uint64(block.number);
    maxReward = _maxReward;

    nativeToken = _nativeToken;
    nativeToken.init(address(this));
  }

  function setOperator(address _operator) public onlyOwner {
    operator = _operator;
    emit NewOperator(_operator);
  }

  function submitPeriod(
    bytes32 _prevHash, 
    bytes32 _root) 
  public onlyOperator returns (uint256 newHeight, uint256 reward) {

    require(periods[_prevHash].parent > 0, "Parent node should exist");
    require(periods[_root].height == 0, "Given root shouldn't be submitted yet");

    // calculate height
    newHeight = periods[_prevHash].height + 1;
    // do some magic if chain extended
    if (newHeight > periods[tipHash].height) {
      // new periods can only be submitted every x Ethereum blocks
      require(
        block.number >= lastParentBlock + parentBlockInterval, 
        "Tried to submit new period too soon"
      );
      tipHash = _root;
      lastParentBlock = uint64(block.number);
      emit NewHeight(newHeight, _root);
    }
    // store the period
    Period memory newPeriod = Period({
      parent: _prevHash,
      height: uint32(newHeight),
      timestamp: uint32(block.timestamp),
      parentIndex: uint32(periods[_prevHash].children.push(_root) - 1),
      children: new bytes32[](0)
    });
    periods[_root] = newPeriod;

    // distribute rewards
    uint256 totalSupply = nativeToken.totalSupply();
    uint256 stakedSupply = nativeToken.balanceOf(operator);
    reward = maxReward;
    if (stakedSupply >= totalSupply.div(2)) {
      // 4 x br x as x (ts - as)
      // -----------------------
      //        ts x ts
      reward = totalSupply.sub(stakedSupply).mul(stakedSupply).mul(maxReward).mul(4).div(totalSupply.mul(totalSupply));
    }
    nativeToken.mint(operator, reward);
  }

}