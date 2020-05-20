
/**
 * Copyright (c) 2018-present, Leap DAO (leapdao.org)
 *
 * This source code is licensed under the Mozilla Public License, version 2,
 * found in the LICENSE file in the root directory of this source tree.
 */

pragma solidity ^0.5.12;

import "../Adminable.sol";

contract BridgeMock is Adminable {
  address public operator;
  uint256 public value;

  function setOperator(address _operator) public ifAdmin {
    operator = _operator;
  }

  function setValue(uint256 _value) public {
    value = _value;
  }
}