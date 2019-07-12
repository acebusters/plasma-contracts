
/**
 * Copyright (c) 2018-present, Leap DAO (leapdao.org)
 *
 * This source code is licensed under the Mozilla Public License, version 2,
 * found in the LICENSE file in the root directory of this source tree.
 */

import { Period, Block, Tx } from 'leap-core';
import EVMRevert from './helpers/EVMRevert';

require('./helpers/setup');

const Bridge = artifacts.require('Bridge');
const PoaOperator = artifacts.require('PoaOperator');
const AdminableProxy = artifacts.require('AdminableProxy');

contract('PoaOperator', (accounts) => {
  const alice = accounts[0];
  const bob = accounts[1];
  const admin = accounts[3];
  const CAS = '0xc000000000000000000000000000000000000000000000000000000000000000';

  describe('Test', () => {
    let bridge;
    let operator;
    let proxy;
    const parentBlockInterval = 0;
    const epochLength = 3;
    const p = [];

    before(async () => {
      const bridgeCont = await Bridge.new();
      let data = await bridgeCont.contract.methods.initialize(parentBlockInterval).encodeABI();
      const proxyBridge = await AdminableProxy.new(bridgeCont.address, data,  {from: admin});
      bridge = await Bridge.at(proxyBridge.address);

      const opCont = await PoaOperator.new();
      data = await opCont.contract.methods.initialize(bridge.address, bridge.address, epochLength).encodeABI();
      proxy = await AdminableProxy.new(opCont.address, data,  {from: admin});
      operator = await PoaOperator.at(proxy.address);

      data = await bridge.contract.methods.setOperator(operator.address).encodeABI();
      await proxyBridge.applyProposal(data, {from: admin});
      p[0] = await bridge.tipHash();
    });
      
    describe('Slot Management', () => {
      it('should prevent submission by empty slot', async () => {
        await operator.submitPeriod(0, p[0], '0x01', '0xff', {from: alice}).should.be.rejectedWith(EVMRevert);
      });

      it('should allow to set slot and submit block', async () => {
        const data = await operator.contract.methods.setSlot(0, alice, alice).encodeABI();
        await proxy.applyProposal(data, {from: admin});
        await operator.submitPeriod(0, p[0], '0x01', CAS, { from: alice }).should.be.fulfilled;
        p[1] = await bridge.tipHash();
      });

      it('period proof should match contract', async () => {
        const data = await operator.contract.methods.setSlot(1, bob, bob).encodeABI();
        await proxy.applyProposal(data, {from: admin});

        const block = new Block(33);
        const depositTx = Tx.deposit(0, 1000, alice);
        block.addTx(depositTx);
        const prevPeriodRoot = await bridge.tipHash();
        const period = new Period(prevPeriodRoot, [block]);
        period.setValidatorData(1, bob, CAS);
        const proof = period.proof(depositTx);

        await operator.submitPeriod(1, p[1], period.merkleRoot(), CAS, { from: bob }).should.be.fulfilled;
        p[2] = await bridge.tipHash();
        assert.equal(p[2], proof[0]);
      });
    });
  });


  describe('Governance', () => {
    let proxy;
    let operator;

    it('should allow to change exit params', async () => {
      const opCont = await PoaOperator.new();
      let data = await opCont.contract.methods.initialize(accounts[0], accounts[0], 2).encodeABI();
      proxy = await AdminableProxy.new(opCont.address, data, {from: accounts[2]});
      operator = await PoaOperator.at(proxy.address);

      // set epochLength
      data = await operator.contract.methods.setEpochLength(2).encodeABI();
      await proxy.applyProposal(data, {from: accounts[2]});
      assert.equal(await operator.epochLength(), 2);
    });
  });

});