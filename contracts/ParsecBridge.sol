pragma solidity ^0.4.19;

import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";

contract ParsecBridge {
  using SafeMath for uint256;

  event Epoch(uint256 epoch);
  event NewHeight(uint256 blockNumber, bytes32 indexed root);
  event NewDeposit(uint32 indexed depositId, address depositor);
  event ValidatorJoin(address indexed signerAddr, uint256 epoch);
  event ValidatorLeave(address indexed signerAddr, uint256 epoch);
  
  bytes32 constant genesis = 0x4920616d207665727920616e6772792c20627574206974207761732066756e21; // "I am very angry, but it was fun!" @victor
  uint256 epochLength;       // length of epoch in periods (32 blocks)
  uint256 public lastCompleteEpoch; // height at which last epoch was completed
  uint256 lastEpochBlockHeight;
  uint256 parentBlockInterval; // how often epochs can be submitted max
  uint64 lastParentBlock; // last ethereum block when epoch was submitted
  uint256 maxReward;    // max reward per period
  uint256 averageGasPrice;   
  bytes32 public tipHash;    // hash of first period that has extended chain to some height
  ERC20 token;
  
  struct Slot {
    address owner;
    uint64 stake;
    address signer;
    uint32 activationEpoch;
    address newOwner;
    uint64 newStake;
    address newSigner;
  }
  
  mapping(uint256 => Slot) slots;

  struct Period {
    bytes32 parent; // the id of the parent node
    uint32 height;  // the height of last block in period
    uint32 parentIndex; //  the position of this node in the Parent's children list
    uint8 slot;
    uint32 gasPrice;
    uint64 reward;
    bytes32[] children; // unordered list of children below this node
  }
  mapping(bytes32 => Period) public periods;

  struct Deposit {
    uint64 height;
    address owner;
    uint256 amount;
  }
  mapping(uint32 => Deposit) public deposits;
  uint32 depositCount = 0;

  struct Exit {
    uint64 amount;
    uint32 opened;
    address owner;
  }
  mapping(bytes32 => Exit) public exits;

    
  constructor(ERC20 _token, uint256 _epochLength, uint256 _maxReward, uint256 _parentBlockInterval) public {
    // set token contract
    require(_token != address(0));
    token = _token;
    // init genesis preiod
    Period memory genesisPeriod;
    genesisPeriod.parent = genesis;
    genesisPeriod.height = 32;
    tipHash = genesis;
    periods[tipHash] = genesisPeriod;
    // epochLength and at the same time number of validator slots
    require(_epochLength < 256);
    require(_epochLength >= 2);
    epochLength = _epochLength;
    // full period reward before taxes and adjustments
    maxReward = _maxReward;
    // parent block settings
    parentBlockInterval = _parentBlockInterval;
    lastParentBlock = uint64(block.number);
  }

  function getSlot(uint256 _slotId) constant public returns (address, uint64, address, uint32, address, uint64, address) {
    require(_slotId < epochLength);
    Slot memory slot = slots[_slotId];
    return (slot.owner, slot.stake, slot.signer, slot.activationEpoch, slot.newOwner, slot. newStake, slot.newSigner);
  }


  // data = [winnerHash, claimCountTotal, operator, operator ...]
  // operator: 1b claimCountByOperator - 10b 0x - 1b stake - 20b address
  function dfs(bytes32[] _data, bytes32 _nodeHash) internal constant returns(bytes32[] data) {
    Period memory node = periods[_nodeHash];
    // visit this node
    data = new bytes32[](_data.length);
    for (uint256 i = 1; i < _data.length; i++) {
      data[i] = _data[i];
    }
    // find the operator that mined this block
    i = node.slot + 2;
    // if operator can claim rewards, assign
    if (uint256(data[i]) == 0) {
      data[i] = bytes32(1);
      data[1] = bytes32(uint256(data[1]) + (1 << 128));
      data[0] = _nodeHash;
    }
    // more of tree to walk
    if (node.children.length > 0) {
      bytes32[][] memory options = new bytes32[][](data.length);
      for (i = 0; i < node.children.length; i++) {
        options[i] = dfs(data, node.children[i]);
      }
      for (i = 0; i < node.children.length; i++) {
        // compare options, return the best
        if (uint256(options[i][1]) > uint256(data[1])) {
          data[0] = options[i][0];
          data[1] = options[i][1];
        }
      }
    }
    else {
      data[0] = _nodeHash;
      data[1] = bytes32(uint256(data[1]) + 1);
    }
    // else - reached a tip
    // return data
  }

  function getTip() public constant returns (bytes32, uint256) {
    // find consensus horizon
    bytes32 consensusHorizon = periods[tipHash].parent;
    uint256 depth = (periods[tipHash].height < epochLength * 32) ? 1 : periods[tipHash].height - (epochLength * 32);
    depth += 32;
    while(periods[consensusHorizon].height > depth) {
      consensusHorizon = periods[consensusHorizon].parent;
    }
    // create data structure for depth first search
    bytes32[] memory data = new bytes32[](epochLength + 2);
    // run search
    bytes32[] memory rsp = dfs(data, consensusHorizon);
    // return result
    return (rsp[0], uint256(rsp[1]) >> 128);
  }
  
  function bet(uint256 _slotId, uint256 _value, address _signerAddr) public {
    require(_slotId < epochLength);
    Slot storage slot = slots[_slotId];
    // take care of logout
    if (_value == 0 && slot.newStake == 0 && slot.signer == _signerAddr) {
      slot.activationEpoch = uint32(lastCompleteEpoch.add(3));
      return;
    }
    uint required = slot.stake;
    if (slot.newStake > required) {
      required = slot.newStake;
    }
    required = required.mul(105).div(100);
    require(required < _value);
    token.transferFrom(msg.sender, this, _value);
    if (slot.newStake > 0) {
      token.transfer(slot.newOwner, slot.newStake);
    }
    // auction
    if (slot.stake > 0) {
      slot.newOwner = msg.sender;
      slot.newSigner = _signerAddr;
      slot.newStake = uint64(_value);
      slot.activationEpoch = uint32(lastCompleteEpoch.add(3));
    }
    // new purchase
    else {
      slot.owner = msg.sender;
      slot.signer = _signerAddr;
      slot.stake = uint64(_value);
      slot.activationEpoch = 0;
      emit ValidatorJoin(slot.signer, lastCompleteEpoch + 1);
    }
  }
  
  function activate(uint256 _slotId) public {
    require(_slotId < epochLength);
    Slot storage slot = slots[_slotId];
    require(lastCompleteEpoch + 1 >= slot.activationEpoch);
    if (slot.stake > 0) {
      token.transfer(slot.owner, slot.stake);
      emit ValidatorLeave(slot.signer, lastCompleteEpoch + 1);
    }
    slot.owner = slot.newOwner;
    slot.signer = slot.newSigner;
    slot.stake = slot.newStake;
    slot.activationEpoch = 0;
    slot.newOwner = 0;
    slot.newSigner = 0;
    slot.newStake = 0;
    emit ValidatorJoin(slot.signer, lastCompleteEpoch + 1);
  }

  function recordGas() internal {
    averageGasPrice = averageGasPrice - (averageGasPrice / 15) + (tx.gasprice / 15);
  }

  function submitAndPrune(uint256 _slotId, bytes32 _prevHash, bytes32 _root, bytes32[] orphans) public {
    submitPeriod(_slotId, _prevHash, _root);
    // delete all blocks that have non-existing parent
    for (uint256 i = 0; i < orphans.length; i++) {
      Period memory orphan = periods[orphans[i]];
      // if period exists
      if (orphan.parent > 0) {
        // if period is orphaned
        if (periods[orphan.parent].parent == 0) {
          // delete period
          delete periods[orphans[i]];
        }
      }
    }
  }
  
  function submitPeriod(uint256 _slotId, bytes32 _prevHash, bytes32 _root) public {
    // check parent node exists
    require(periods[_prevHash].parent > 0);
    // check that same root not submitted yet
    require(periods[_root].height == 0);
    // check slot
    require(_slotId < epochLength);
    Slot storage slot = slots[_slotId];
    require(slot.signer == msg.sender);
    if (slot.activationEpoch > 0) {
      // if slot not active, prevent submission
      require(lastCompleteEpoch.add(2) < slot.activationEpoch);
    }

    // calculate height
    uint256 newHeight = periods[_prevHash].height + 32;
    // do some magic if chain extended
    if (newHeight > periods[tipHash].height) {
      // new periods can only be submitted every x Ethereum blocks
      require(block.number >= lastParentBlock + parentBlockInterval);
      tipHash = _root;
      lastParentBlock = uint64(block.number);
      emit NewHeight(newHeight, _root);
    }
    // store the period
    Period memory newPeriod;
    newPeriod.parent = _prevHash;
    newPeriod.height = uint32(newHeight);
    newPeriod.slot = uint8(_slotId);
    newPeriod.parentIndex = uint32(periods[_prevHash].children.push(_root) - 1);
    periods[_root] = newPeriod;

    // record gas
    recordGas();

    // distribute rewards
    uint256 totalSupply = token.totalSupply();
    uint256 stakedSupply = token.balanceOf(this);
    uint256 reward = maxReward;
    if (stakedSupply >= totalSupply.div(2)) {
      // 4 x br x as x (ts - as)
      // -----------------------
      //        ts x ts
      reward = totalSupply.sub(stakedSupply).mul(stakedSupply).mul(maxReward).mul(4).div(totalSupply.mul(totalSupply));
    }
    slot.stake += uint64(reward);

    // check if epoch completed
    if (newHeight >= lastEpochBlockHeight.add(epochLength.mul(32))) {
      lastCompleteEpoch++;
      lastEpochBlockHeight = newHeight;
    }
  }

  function deletePeriod(bytes32 hash) internal {
    Period storage parent = periods[periods[hash].parent];
    uint256 i = periods[hash].parentIndex;
    if (i < parent.children.length - 1) {
      // swap with last child
      parent.children[i] = parent.children[parent.children.length - 1];
    }
    parent.children.length--;
    if (hash == tipHash) {
      tipHash = periods[hash].parent;
    }
    delete periods[hash];
  }

  function getMerkleRoot(bytes32 _leaf, uint256 _index, uint256 _offset, bytes32[] _proof) internal pure returns (bytes32) {
    for (uint256 i = _offset; i < _proof.length; i++) {
      // solhint-disable-next-line no-inline-assembly
      if (_index % 2 == 0) {
        _leaf = keccak256(_leaf, _proof[i]);
      } else {
        _leaf = keccak256(_proof[i], _leaf);
      }
      _index = _index / 2;
    }
    return _leaf;
  }

  //validate that transaction is included to the period (merkle proof)
  function validateProof(uint256 offset, bytes32[] _proof) pure internal returns (uint64 txPos, bytes32 txHash) {
    uint256 txLength = uint16(_proof[3] >> 224);
    bytes memory txData = new bytes(txLength);
    assembly {
      calldatacopy(add(txData, 0x20), add(178, offset), txLength)
    }
    txHash = keccak256(txData);
    txPos = uint64(_proof[3] >> 160);
    bytes32 root = getMerkleRoot(txHash, txPos, uint8(_proof[3] >> 240), _proof);
    require(root == _proof[0]);
  }

  /*
   * _txData = [ 32b blockHash, 32b r, 32b s, (1b Proofoffset, 8b pos, 1b v, ..00.., 1b txData), 32b txData, 32b proof, 32b proof ]
   *
   * # 2 Deposit TX (33b)
   *   1b type
   *     4b depositId
   *     8b value, 20b address
   *
   */
  function reportInvalidDeposit(bytes32[] _txData) public {
    Period memory p = periods[_txData[0]];
    if (periods[tipHash].height > epochLength) {
      require(p.height > periods[tipHash].height - epochLength);
    }
    // check transaction proof
    validateProof(17, _txData);

    // check deposit values
    uint32 depositId = uint32(_txData[4] >> 224);
    uint64 value = uint64(_txData[4] >> 160);
    Deposit memory dep = deposits[depositId];
    require(value != dep.amount || address(_txData[4]) != dep.owner);

    // delete invalid period
    deletePeriod(_txData[0]);
    // EVENT
    // slash operator
    slash(p.slot, 10 * maxReward);
    // reward 1 block reward
    token.transfer(msg.sender, maxReward);
  }

  function reportDoubleSpend(bytes32[] _proof, bytes32[] _prevProof) public {
    Period memory p = periods[_proof[0]];

    // validate proofs
    uint256 offset = 32 * (_proof.length + 2);
    uint64 txPos1;
    (txPos1, ) = validateProof(offset + 10, _prevProof);

    uint64 txPos2;
    (txPos2, ) = validateProof(42, _proof);

    // make sure transactions are different
    require(_proof[0] != _prevProof[0] || txPos1 != txPos2);

    // get iputs and validate
    bytes32 prevHash1;
    bytes32 prevHash2;
    uint8 outPos1;
    uint8 outPos2;
    assembly {
      prevHash1 := calldataload(add(198, 32))
      outPos1 := calldataload(add(230, 32))
      prevHash2 := calldataload(add(198, offset))
      outPos2 := calldataload(add(230, offset))
    }

    // check that spending same outputs
    require(prevHash1 == prevHash2 && outPos1 == outPos2);
    // delete invalid period
    deletePeriod(_proof[0]);
    // EVENT
    // slash operator
    slash(p.slot, 50);
  }
  
  function slash(uint256 _slotId, uint256 _value) public {
    require(_slotId < epochLength);
    Slot storage slot = slots[_slotId];
    require(slot.stake > 0);
    uint256 prevStake = slot.stake;
    slot.stake = (_value >= slot.stake) ? 0 : slot.stake - uint64(_value);
    // if slot became empty by slashing
    if (prevStake > 0 && slot.stake == 0) {
      emit ValidatorLeave(slot.signer, lastCompleteEpoch + 1);
      slot.activationEpoch = 0;
      if (slot.newStake > 0) {
        // someone in queue
        activate(_slotId);
      } else {
        // clean out account
        slot.owner = 0;
        slot.signer = 0;
        slot.stake = 0;
      }
    }
  }

  /*
   * Add funds
   */
  function deposit(uint256 amount) public {
    token.transferFrom(msg.sender, this, amount);
    depositCount++;
    deposits[depositCount] = Deposit({
      height: periods[tipHash].height,
      owner: msg.sender,
      amount: amount
    });
    emit NewDeposit(depositCount, msg.sender);
  }


  function recoverTxSigner(uint256 offset, bytes32[] _proof) internal pure returns (address dest) {
    uint16 txLength = uint16(_proof[3] >> 224);
    bytes memory txData = new bytes(txLength);
    bytes32 r;
    bytes32 s;
    uint8 v;
    assembly {
      calldatacopy(add(txData, 32), add(178, offset), 43)
      r := calldataload(add(221, offset))
      s := calldataload(add(253, offset))
      v := calldataload(add(254, offset))
      calldatacopy(add(txData, 140), add(286, offset), 28) // 32 + 43 + 65
    }
    dest = ecrecover(keccak256(txData), v, r, s);
  }

  /*
   * Take funds
   */
  function withdrawBurn(bytes32[] _proof) public {
    // make sure block is final
    // Period memory p = periods[_proof[0]];
    // require(periods[tipHash].height * 32 > epochLength);
    // require(p.height < periods[tipHash].height - (epochLength * 32));

    // validate proof
    bytes32 txHash;
    ( , txHash) = validateProof(10, _proof);

    // check not withdrawn yet
    require(exits[txHash].amount == 0);

    address dest;
    uint64 amount;
    assembly {
      // first output
      amount := calldataload(272)
      dest := calldataload(292)
    }
    require(dest == address(this));

    // recover signer
    dest = recoverTxSigner(10, _proof);

    exits[txHash] = Exit({
      amount: amount,
      opened: uint32(now - 4 days),
      owner: dest
    });

    // EVENT
    token.transfer(dest, amount);
  }

}