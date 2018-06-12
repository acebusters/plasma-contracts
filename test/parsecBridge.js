import utils from 'ethereumjs-util';
import EVMRevert from './helpers/EVMRevert';
import { Period, Block, Tx, Input, Output, Outpoint } from 'parsec-lib';
import assertRevert from './helpers/assertRevert';
import chai from 'chai';
const ParsecBridge = artifacts.require('./ParsecBridge.sol');
const SimpleToken = artifacts.require('SimpleToken');

const should = chai
  .use(require('chai-as-promised'))
  .should();

contract('Parsec', (accounts) => {
  const alice = accounts[0];
  const alicePriv = '0x278a5de700e29faae8e40e366ec5012b5ec63d36ec77e8a2417154cc1d25383f';
  const bob = accounts[1];
  const bobPriv = '0x7bc8feb5e1ce2927480de19d8bc1dc6874678c016ae53a2eec6a6e9df717bfac';
  const charlie = accounts[2];
  const charliePriv = '0x94890218f2b0d04296f30aeafd13655eba4c5bbf1770273276fee52cbe3f2cb4';

  describe('Slot', function() {
    const p = [];
    let parsec;
    let token;
    before(async () => {
      token = await SimpleToken.new();
      // initialize contract
      parsec = await ParsecBridge.new(token.address, 3, 50, 0, 0);
      p[0] = await parsec.tipHash();
      token.transfer(bob, 1000);
      token.transfer(charlie, 1000);
    });
    describe('Auction', function() {
      it('should prevent submission by unbonded validators', async () => {
        await parsec.submitPeriod(0, p[0], '0x01', {from: alice}).should.be.rejectedWith(EVMRevert);
      });

      it('should allow to auction slot and submit block', async () => {
        await token.approve(parsec.address, 1000, {from: alice});
        await parsec.bet(0, 100, alice, alice, {from: alice}).should.be.fulfilled;
        await parsec.submitPeriod(0, p[0], '0x01', {from: alice}).should.be.fulfilled;
        p[1] = await parsec.tipHash();
      });

      it('should update slot instead of auction for same owner', async () => {
        const bal1 = await token.balanceOf(alice);
        await parsec.bet(2, 10, alice, alice, {from: alice}).should.be.fulfilled;
        await parsec.bet(2, 30, alice, alice, {from: alice}).should.be.fulfilled;
        const bal2 = await token.balanceOf(alice);
        const slot = await parsec.slots(2);
        assert.equal(Number(slot[1]), 30); // stake === 30
        assert.equal(Number(slot[6]), 0); // newStake === 0
        // all token missing in balance should be accounted in slot
        assert.equal(bal1.sub(bal2).toNumber(), Number(slot[1]));
      });

      it('should prevent auctining for lower price', async () => {
        await token.approve(parsec.address, 1000, {from: bob});
        await parsec.bet(0, 129, bob, bob, {from: bob}).should.be.rejectedWith(EVMRevert);
        await parsec.bet(0, 131, bob, bob, {from: bob}).should.be.rejectedWith(EVMRevert);
      });

      it('should allow to be slashed',  async () => {
        await parsec.slash(0, 20).should.be.fulfilled;
      });

      it('should allow to auction for higer price',  async () => {
        await parsec.bet(0, 150, bob, bob, {from: bob}).should.be.fulfilled;
      });

      it('should allow submission when slot auctioned in same epoch', async () => {
        await parsec.submitPeriod(0, p[1], '0x02', {from: alice}).should.be.fulfilled;
        p[2] = await parsec.tipHash();
      });

      it('should prevent submission by auctioned slot in later epoch', async () => {
        await parsec.submitPeriod(0, p[2], '0x03', {from: alice}).should.be.rejectedWith(EVMRevert);
        await parsec.submitPeriod(0, p[2], '0x03', {from: bob}).should.be.rejectedWith(EVMRevert);
      });

      it('allow to auction another slot', async () => {
        await token.approve(parsec.address, 1000, {from: charlie});
        await parsec.bet(1, 100, charlie, charlie, {from: charlie}).should.be.fulfilled;
      });

      it('should allow to activate auctioned slot and submit', async () => {
        // increment Epoch
        await parsec.submitPeriod(1, p[2], '0x03', {from: charlie}).should.be.fulfilled;
        p[3] = await parsec.tipHash();
        await parsec.submitPeriod(1, p[3], '0x04', {from: charlie}).should.be.fulfilled;
        p[4] = await parsec.tipHash();
        await parsec.submitPeriod(1, p[4], '0x05', {from: charlie}).should.be.fulfilled;
        p[5] = await parsec.tipHash();
        let tip = await parsec.getTip();
        assert.equal(p[5], tip[0]);
        await parsec.submitPeriod(1, p[5], '0x06', {from: charlie}).should.be.fulfilled;
        p[6] = await parsec.tipHash();
        // activate and submit by bob
        const bal1 = await token.balanceOf(alice);
        await parsec.activate(0);
        const bal2 = await token.balanceOf(alice);
        assert.equal(bal1.add(180).toNumber(), bal2.toNumber());
        await parsec.submitPeriod(0, p[6], '0x07', {from: bob}).should.be.fulfilled;
        p[7] = await parsec.tipHash();
      });

      it('should allow to logout', async () => {
        await parsec.bet(0, 0, bob, bob, {from: bob}).should.be.fulfilled;
      });

      it('should prevent submission by logged-out slot in later epoch', async () => {
        // increment epoch
        await parsec.submitPeriod(1, p[7], '0x08', {from: charlie}).should.be.fulfilled;
        p[8] = await parsec.tipHash();
        // try to submit when logged out
        await parsec.submitPeriod(0, p[8], '0x09', {from: bob}).should.be.rejectedWith(EVMRevert);
      });

      it('should allow to withdraw after logout', async () => {
        // increment epoch
        await parsec.submitPeriod(1, p[8], '0x09', {from: charlie}).should.be.fulfilled;
        p[9] = await parsec.tipHash();
        await parsec.submitPeriod(1, p[9], '0x0a', {from: charlie}).should.be.fulfilled;
        p[10] = await parsec.tipHash();
        await parsec.submitPeriod(1, p[10], '0x0b', {from: charlie}).should.be.fulfilled;
        p[11] = await parsec.tipHash();
        // activate logout
        token.transfer(parsec.address, 2000);
        const bal1 = await token.balanceOf(bob);
        await parsec.activate(0);
        const bal2 = await token.balanceOf(bob);
        assert.equal(bal1.add(200).toNumber(), bal2.toNumber());
        // including genesis period, we have submiteed 12 periods in total:
        // epoch 1: period 0 - 2
        // epoch 2: period 3 - 5
        // epoch 3: period 6 - 8
        // epoch 4: period 9 - 11
        // =>  now we should be in epoch 5
        const lastEpoch = await parsec.lastCompleteEpoch();
        assert.equal(lastEpoch.toNumber(), 4);
        const height = await parsec.periods(p[11]);
        // we should have 12 * 32 => 384 blocks at this time
        assert.equal(height[1].toNumber(), 384);
      });
    });
  });

  describe('Consensus', function() {
    const p = [];
    let parsec;
    let token;
    before(async () => {
      token = await SimpleToken.new();
      // initialize contract
      parsec = await ParsecBridge.new(token.address, 8, 50, 0, 0);
      p[0] = await parsec.tipHash();
      token.transfer(bob, 1000);
      token.transfer(charlie, 1000);
    });

    describe('Fork choice', function() {
      //
      // p0[] -> p1[s0] -> p2[s4]
      //
      it('should allow to extend chain', async () => {
        await token.approve(parsec.address, 10000, {from: alice}).should.be.fulfilled;
        await parsec.bet(0, 100, alice, alice, {from: alice}).should.be.fulfilled;
        await parsec.bet(1, 100, alice, alice, {from: alice}).should.be.fulfilled;
        await parsec.bet(2, 100, alice, alice, {from: alice}).should.be.fulfilled;
        await parsec.bet(3, 100, alice, alice, {from: alice}).should.be.fulfilled;

        let block = new Block(p[0], 32).addTx(Tx.coinbase(100, alice));
        block.sign(alicePriv);
        let period = new Period([block]);
        p[1] = period.merkleRoot();
        await parsec.submitPeriod(0, p[0], p[1], {from: alice}).should.be.fulfilled;
        const tip = await parsec.getTip();
        assert.equal(p[1], tip[0]);

        await token.approve(parsec.address, 1000, {from: bob}).should.be.fulfilled;
        await parsec.bet(4, 100, bob, bob, {from: bob}).should.be.fulfilled;

        block = new Block(p[1], 64).addTx(Tx.coinbase(200, bob));
        block.sign(bobPriv);
        period = new Period([block]);
        p[2] = period.merkleRoot();
        await parsec.submitPeriod(4, p[1], p[2], {from: bob}).should.be.fulfilled;
        assert.equal(p[2], await parsec.tipHash());
      });

      //                         /-> p3[s5]  <- 3 rewards
      // p0[] -> p1[s0] -> p2[s4] -> p4[s1]  <- 3 rewards
      //                         \-> p5[s4]  <- 2 rewards
      it('should allow to branch', async () => {
        await token.approve(parsec.address, 1000, {from: charlie}).should.be.fulfilled;
        await parsec.bet(5, 100, charlie, charlie, {from: charlie}).should.be.fulfilled;
        await parsec.bet(6, 100, charlie, charlie, {from: charlie}).should.be.fulfilled;
        await parsec.bet(7, 100, charlie, charlie, {from: charlie}).should.be.fulfilled;

        // 3 blocks in parallel
        let block = new Block(p[2], 96).addTx(Tx.coinbase(300, charlie));
        block.sign(charliePriv);
        let period = new Period([block]);
        p[3] = period.merkleRoot();
        await parsec.submitPeriod(5, p[2], p[3], {from: charlie}).should.be.fulfilled;
        let tip = await parsec.getTip();
        assert.equal(p[3], (await parsec.getTip())[0]);

        block = new Block(p[2], 96).addTx(Tx.coinbase(300, alice));
        block.sign(alicePriv);
        period = new Period([block]);
        p[4] = period.merkleRoot();
        await parsec.submitPeriod(1, p[2], p[4], {from: alice}).should.be.fulfilled;

        block = new Block(p[2], 96).addTx(Tx.coinbase(300, bob));
        block.sign(bobPriv);
        period = new Period([block]);
        p[5] = period.merkleRoot();
        await parsec.submitPeriod(4, p[2], p[5], {from: bob}).should.be.fulfilled;

        // tip not updated because bob reused slot
        tip = await parsec.getTip();
        assert.equal(p[3], tip[0]);
        assert.equal(3, tip[1].toNumber());
      });

      //                         /-> p3[s5]  <- 3 rewards
      // p0[] -> p1[s0] -> p2[s4] -> p4[s1]  <- 3 rewards
      //                         \-> p5[s4] -> p6[s2] -> p7[s3]  <- 4 rewards
      it('should allow build longer chain', async () => {
        // submit new height, but same rewards as other tips
        let block = new Block(p[5], 128).addTx(Tx.coinbase(400, alice));
        block.sign(alicePriv);
        let period = new Period([block]);
        p[6] = period.merkleRoot();
        await parsec.submitPeriod(2, p[5], p[6], {from: alice}).should.be.fulfilled;
        // check tip
        let tip = await parsec.getTip();
        assert.equal(p[3], tip[0]);
        assert.equal(3, tip[1].toNumber());

        // submit tip with most rewards
        block = new Block(p[6], 160).addTx(Tx.coinbase(500, alice));
        block.sign(alicePriv);
        period = new Period([block]);
        p[7] = period.merkleRoot();
        await parsec.submitPeriod(3, p[6], p[7], {from: alice}).should.be.fulfilled;
        // check tip
        tip = await parsec.getTip();
        assert.equal(p[7], tip[0]);
        assert.equal(4, tip[1].toNumber());
      });

      //                         /-> p3[s5]  <- 3 rewards
      // p0[] -> p1[s0] -> p2[s4] -> p4[s1] -> p8[s6] -> p9[s7] -> p10[s2]   <- 6 rewards
      //                         \-> p5[s4] -> p6[s2] -> p7[s3]  <- 4 rewards
      it('should allow to extend other branch', async () => {

        let block = new Block(p[4], 128).addTx(Tx.coinbase(400, charlie));
        block.sign(charliePriv);
        let period = new Period([block]);
        p[8] = period.merkleRoot();
        await parsec.submitPeriod(6, p[4], p[8], {from: charlie}).should.be.fulfilled;

        block = new Block(p[8], 160).addTx(Tx.coinbase(500, charlie));
        block.sign(charliePriv);
        period = new Period([block]);
        p[9] = period.merkleRoot();
        await parsec.submitPeriod(7, p[8], p[9], {from: charlie}).should.be.fulfilled;

        block = new Block(p[9], 192).addTx(Tx.coinbase(600, alice));
        block.sign(alicePriv);
        period = new Period([block]);
        p[10] = period.merkleRoot();
        await parsec.submitPeriod(2, p[9], p[10], {from: alice}).should.be.fulfilled;

        // check tip
        let tip = await parsec.getTip();
        assert.equal(p[10], tip[0]);
        assert.equal(6, tip[1].toNumber());
      });

      it('should allow to clip off light branch');

      //                           /-> xxxxxx
      // b[0,c] -> b[1,c] -> b[2,d] -> b[4,c] -> b[7,e] -> b[8,e] -> ... -> b[15]
      //                           \-> xxxxxx -> b[6,c] -> b[16,c]
      it('should allow to prune');
    });

    describe('Block submission', function() {
      it('should properly change avg gas price', async () => {
        let lowGas = 10 ** 11;
        let highGas = 50 * (10 ** 11);

        let initialAvg = await parsec.averageGasPrice.call();

        let block = new Block(p[10], 224).addTx(Tx.coinbase(700, alice));
        block.sign(alicePriv);
        let period = new Period([block]);
        p[11] = period.merkleRoot();
        await parsec.submitPeriod(0, p[10], p[11], {from: alice, gasPrice: highGas}).should.be.fulfilled;

        let incrAvg = await parsec.averageGasPrice.call();
        assert(incrAvg > initialAvg);
        let reqValue1 = Math.ceil(initialAvg.toNumber() - initialAvg.toNumber() / 15 + highGas / 15);
        assert.equal(incrAvg.toNumber(), reqValue1);

        block = new Block(p[11], 256).addTx(Tx.coinbase(800, alice));
        block.sign(alicePriv);
        period = new Period([block]);
        p[12] = period.merkleRoot();
        await parsec.submitPeriod(1, p[11], p[12], {from: alice, gasPrice: lowGas}).should.be.fulfilled;

        let decrAvg = await parsec.averageGasPrice.call();
        assert(decrAvg < incrAvg);
        let reqValue2 = Math.ceil(incrAvg.toNumber() - incrAvg.toNumber() / 15 + lowGas / 15);
        assert.equal(decrAvg.toNumber(), reqValue2);
      })
    });
  });

  describe('Deposits and Exits', function() {
    const p = [];
    let parsec;
    let token;
    before(async () => {
      token = await SimpleToken.new();
      // initialize contract
      parsec = await ParsecBridge.new(token.address, 8, 50, 0, 0);
      p[0] = await parsec.tipHash();
      // alice auctions slot
      await token.approve(parsec.address, 1000, {from: alice});
      await parsec.bet(0, 100, alice, alice, {from: alice}).should.be.fulfilled;
      // bob auctions slot
      token.transfer(bob, 1000);
      await token.approve(parsec.address, 1000, {from: bob});
      await parsec.bet(1, 100, bob, bob, {from: bob}).should.be.fulfilled;
      // charlie auctions slot
      token.transfer(charlie, 1000);
      await token.approve(parsec.address, 1000, {from: charlie});
      await parsec.bet(2, 100, charlie, charlie, {from: charlie}).should.be.fulfilled;
    });

    describe('Deposit', function() {
      it('should allow to deposit', async () => {
        // deposit 1
        let receipt = await parsec.deposit(200, { from: bob });
        const depositId1 = receipt.logs[0].args.depositId.toNumber();
        // deposit 2
        receipt = await parsec.deposit(300, { from: alice });
        const depositId2 = receipt.logs[0].args.depositId.toNumber();
        assert(depositId1 < depositId2);
      });
    });
    describe('Exit', function() {
      it('should allow to exit burned funds', async () => {
        const coinbase = Tx.coinbase(50, alice);
        let transfer = Tx.transfer(
          64,
          [new Input(new Outpoint(coinbase.hash(), 0))],
          [new Output(50, parsec.address)]
        );

        transfer = transfer.sign([alicePriv]);
        let block = new Block(p[0], 64).addTx(coinbase).addTx(transfer);
        block.sign(alicePriv);
        let period = new Period([block]);
        p[1] = period.merkleRoot();
        await parsec.submitPeriod(0, p[0], p[1], {from: alice}).should.be.fulfilled;
        const proof = period.proof(transfer);

        // withdraw burned output
        const bal1 = await token.balanceOf(alice);
        await parsec.withdrawBurn(proof);
        const bal2 = await token.balanceOf(alice);
        assert(bal1.toNumber() < bal2.toNumber());
      });

      it('should allow to exit valid utxo', async () => {
        const coinbase = Tx.coinbase(50, alice);
        let transfer = Tx.transfer(
          96,
          [new Input(new Outpoint(coinbase.hash(), 0))],
          [new Output(50, bob)]
        );

        transfer = transfer.sign([alicePriv]);
        let block = new Block(p[1], 96).addTx(coinbase).addTx(transfer);
        block.sign(alicePriv);
        let period = new Period([block]);
        p[2] = period.merkleRoot();
        await parsec.submitPeriod(0, p[1], p[2], {from: alice}).should.be.fulfilled;
        const proof = period.proof(transfer);

        // withdraw output
        const event = await parsec.startExit(proof);
        const bal1 = await token.balanceOf(bob);
        await parsec.finalizeExits();
        const bal2 = await token.balanceOf(bob);
        assert(bal1.toNumber() < bal2.toNumber());
      });

      it('should allow to challenge exit', async () => {
        const coinbase = Tx.coinbase(50, alice);
        // utxo that will try exit
        let transfer = Tx.transfer(
          128,
          [new Input(new Outpoint(coinbase.hash(), 0))],
          [new Output(50, bob)]
        );
        transfer = transfer.sign([alicePriv]);
        // utxo that will have spend exit utxo
        let spend = Tx.transfer(
          128,
          [new Input(new Outpoint(transfer.hash(), 0))],
          [new Output(50, charlie)]
        );
        spend = spend.sign([bobPriv]);
        // submit period and get proofs
        let block = new Block(p[2], 128).addTx(coinbase).addTx(transfer).addTx(spend);
        block.sign(alicePriv);
        let period = new Period([block]);
        p[3] = period.merkleRoot();
        await parsec.submitPeriod(0, p[2], p[3], {from: alice}).should.be.fulfilled;
        const proof = period.proof(transfer);
        const spendProof = period.proof(spend);

        // withdraw output
        const event = await parsec.startExit(proof);
        const outpoint = new Outpoint(
          event.logs[0].args.txHash,
          event.logs[0].args.outIndex.toNumber()
        );
        assert.equal(outpoint.getUtxoId(), spend.inputs[0].prevout.getUtxoId());


        // challenge exit and make sure exit is removed
        let exit = await parsec.exits(outpoint.getUtxoId());
        assert.equal(exit[1], bob);
        await parsec.challengeExit(spendProof, proof);
        exit = await parsec.exits(outpoint.getUtxoId());
        assert.equal(exit[1], '0x0000000000000000000000000000000000000000');
      });
    });
  });

  describe('Slashing', function() {
    const p = [];
    let parsec;
    let token;
    before(async () => {
      token = await SimpleToken.new();
      // initialize contract
      parsec = await ParsecBridge.new(token.address, 8, 50, 0, 0);
      p[0] = await parsec.tipHash();
      await token.approve(parsec.address, 1000, {from: alice});
      await parsec.bet(0, 100, alice, alice, {from: alice}).should.be.fulfilled;
      token.transfer(charlie, 1000);
      await token.approve(parsec.address, 1000, {from: charlie});
      await parsec.bet(1, 100, charlie, charlie, {from: charlie}).should.be.fulfilled;
      await parsec.bet(2, 100, charlie, charlie, {from: charlie}).should.be.fulfilled;
    });

    describe('Double Spend', function() {
      it('should allow to slash doublespend', async () => {
        // create some tx spending an output
        const prevTx = '0x7777777777777777777777777777777777777777777777777777777777777777';
        const value = 99000000;
        let transfer = Tx.transfer(
          6,
          [new Input(new Outpoint(prevTx, 0))],
          [new Output(value, alice)]
        );
        transfer = transfer.sign([alicePriv]);

        // submit that tx
        let block = new Block(p[0], 32);
        block.addTx(transfer);
        block.addTx(Tx.deposit(12, value, alice));
        block.sign(charliePriv);
        let period = new Period([block]);
        p[1] = period.merkleRoot();
        await parsec.submitPeriod(1, p[0], p[1], {from: charlie}).should.be.fulfilled;
        const prevProof = period.proof(transfer);

        // submit tx spending same out in later block
        block = new Block(p[1], 64).addTx(transfer);
        block.sign(bobPriv);
        period = new Period([block]);
        p[2] = period.merkleRoot();
        await parsec.submitPeriod(2, p[1], p[2], {from: charlie}).should.be.fulfilled;
        const proof = period.proof(transfer);

        // check tip
        let tip = await parsec.getTip();
        assert.equal(p[2], tip[0]);

        // submit proof and get block deleted
        const bal1 = (await parsec.getSlot(2))[1];
        await parsec.reportDoubleSpend(proof, prevProof, {from: alice});
        const bal2 = (await parsec.getSlot(2))[1];
        assert(bal1.toNumber() > bal2.toNumber());

        // check tip
        tip = await parsec.getTip();
        assert.equal(p[1], tip[0]);
      });
    });
    describe('Deposit', function() {
      it('should allow to slash invalid deposit', async () => {
        // deposit
        const receipt = await parsec.deposit(50, { from: charlie });
        const depositId = receipt.logs[0].args.depositId.toNumber();
        const deposit = Tx.deposit(depositId, 50, alice);

        // wait until operator included
        let block = new Block(p[1], 92).addTx(deposit);
        block.sign(alicePriv);
        let period = new Period([block]);
        p[2] = period.merkleRoot();
        await parsec.submitPeriod(0, p[1], p[2], {from: alice}).should.be.fulfilled;
        const proof = period.proof(deposit);

        // complain, if deposit tx wrong
        const bal1 = (await parsec.getSlot(0))[1];
        await parsec.reportInvalidDeposit(proof, {from: charlie});
        const bal2 = (await parsec.getSlot(0))[1];
        assert(bal1.toNumber() > bal2.toNumber());
      });
      it('should allow to slash double deposit');
    });
    describe('Same Height', function() {
      it('should allow to slash two periods at same height');
    });
  });
});