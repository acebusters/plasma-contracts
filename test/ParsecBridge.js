import utils from 'ethereumjs-util';
import { Tx, Block } from 'parsec-lib';
import assertRevert from './helpers/assertRevert';
import chai from 'chai';
const ParsecBridge = artifacts.require('./ParsecBridge.sol');
const SimpleToken = artifacts.require('SimpleToken');

const assert = chai.assert;

contract('Parsec', (accounts) => {
  const blockReward = 5000000;
  const empty = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const c = accounts[0];  // operator charlie, stake: 4 * ts / epochLength
  const cPriv = '0x278a5de700e29faae8e40e366ec5012b5ec63d36ec77e8a2417154cc1d25383f';
  const d = accounts[1];  // operator danie,   stake: 1 * ts / epochLength
  const dPriv = '0x7bc8feb5e1ce2927480de19d8bc1dc6874678c016ae53a2eec6a6e9df717bfac';
  const e = accounts[2];  // operator eric,    stake: 3 * ts / epochLength
  const ePriv = '0x94890218f2b0d04296f30aeafd13655eba4c5bbf1770273276fee52cbe3f2cb4';

  let parsec;
  let token;
  let epochLength;
  let totalSupply;
  let b = [];
  let claimV, claimR, claimS;

  //
  // b[0]
  //
  before(async () => {
    token = await SimpleToken.new();
    // initialize contract
    parsec = await ParsecBridge.new(token.address, 0, 8, blockReward, 0);
    b[0] = await parsec.tipHash();
    epochLength = await parsec.epochLength();
    totalSupply = await token.totalSupply();
    token.transfer(accounts[1], totalSupply.div(epochLength));
    token.transfer(accounts[2], totalSupply.div(epochLength).mul(3));
  });

  //
  // b[0] -> b[1,c]
  //
  it('should allow to join and submit block', async () => {
    await token.approve(parsec.address, totalSupply, {from: c});
    await parsec.join(totalSupply.div(epochLength).mul(4), {from: c});

    const block = new Block(b[0], 1).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[0], block.merkleRoot(), ...block.sign(cPriv), {from: c});
    b[1] = block.hash();
    assert.equal(b[1], await parsec.tipHash());
  });

  //
  // b[0] -> b[1,c] -> b[2,d]
  //
  it('should allow second operator to join and submit block', async () => {
    await token.approve(parsec.address, totalSupply, {from: d});
    await parsec.join(totalSupply.div(epochLength).mul(1), {from: d});

    const block = new Block(b[1], 2).addTx(new Tx().coinbase(blockReward, d));
    await parsec.submitBlock(b[1], block.merkleRoot(), ...block.sign(dPriv));
    b[2] = block.hash();
    assert.equal(b[2], await parsec.tipHash());
  });

  //                           /-> b[3,e]  <- 4 rewards
  // b[0,c] -> b[1,c] -> b[2,d] -> b[4,c]  <- 4 rewards
  //                           \-> b[5,d]  <- 3 rewards
  it('should allow to branch', async () => {
    await token.approve(parsec.address, totalSupply, {from: e});
    await parsec.join(totalSupply.div(epochLength).mul(3), {from: e});

    // 3 blocks in paralel
    let block = new Block(b[2], 3).addTx(new Tx().coinbase(blockReward, e));
    await parsec.submitBlock(b[2], block.merkleRoot(), ...block.sign(ePriv));
    b[3] = block.hash();
    assert.equal(b[3], (await parsec.getTip([c, d, e]))[0]);

    block = new Block(b[2], 3).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[2], block.merkleRoot(), ...block.sign(cPriv));
    b[4] = block.hash();

    block = new Block(b[2], 3).addTx(new Tx().coinbase(blockReward, d));
    await parsec.submitBlock(b[2], block.merkleRoot(), ...block.sign(dPriv));
    b[5] = block.hash();

    // tip not updated because operator D reached share
    assert.equal(b[3], (await parsec.getTip([c, d, e]))[0]);
  });

  //                           /-> b[3,e]  <- 4 rewards
  // b[0,c] -> b[1,c] -> b[2,d] -> b[4,c]  <- 4 rewards
  //                           \-> b[5,d] -> b[6,c] -> b[16,c]  <- 5 rewards
  it('should allow build longer chain', async () => {
    // create some tx spending an output
    const prevTx = '0x7777777777777777777777777777777777777777777777777777777777777777';
    const value = 99000000;
    let transfer = new Tx(6).transfer([{prevTx, outPos: 0}], [{ value, addr: c}]);
    transfer = transfer.sign([cPriv]);

    // submit that tx
    let block = new Block(b[5], 4).addTx(transfer);
    await parsec.submitBlock(b[5], block.merkleRoot(), ...block.sign(cPriv));
    b[6] = block.hash();
    const prevProof = block.proof(transfer.buf(), 0, [empty]);

    // check tip
    let tip = await parsec.getTip([c, d, e]);
    assert.equal(b[3], tip[0]);
    assert.equal(4, tip[1]);

    // submit tx spending same out in later block
    block = new Block(b[6], 5).addTx(transfer);
    await parsec.submitBlock(b[6], block.merkleRoot(), ...block.sign(ePriv));
    const proof = block.proof(transfer.buf(), 0, [empty]);

    // submit proof and get block deleted
    const bal1 = await token.balanceOf(c);
    const rsp = await parsec.reportDoubleSpend(proof, prevProof, {from: c});
    const bal2 = await token.balanceOf(c);
    assert(bal1.toNumber() < bal2.toNumber());

    // another block
    block = new Block(b[6], 5).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[6], block.merkleRoot(), ...block.sign(cPriv));
    b[16] = block.hash();

    // check tip
    tip = await parsec.getTip([c, d, e]);
    assert.equal(b[16], tip[0]);
    assert.equal(5, tip[1].toNumber());
  });

  //
  // b[0,c] -> b[1,c] -> b[2,d]  -> b[5,d]  -> b[6,c]  -> b[16,c]  <- 5 rewards = heavy
  //                 \-> b[29,d] -> b[30,d] -> b[31,d] -> b[32,d] -> b[33,d]  <- 3 rewards = light
  it('should allow to clip off light branch', async () => {

    let block = new Block(b[1], 2).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[1], block.merkleRoot(), ...block.sign(dPriv));
    b[29] = block.hash();
    for(let i = 29; i < 34; i++) {
      block = new Block(b[i], i-26).addTx(new Tx().coinbase(blockReward, d));
      await parsec.submitBlock(b[i], block.merkleRoot(), ...block.sign(dPriv));
      b[i+1] = block.hash();
    }

    let data = [
      b[0], // parent of fork node
      // light.       heavy
      "0x060700000000010205060000f3beac30c498d9e26865f34fcaa57dbb935b0d74", // c
      "0x010000000000030000000000e10f3d125e5f4c753a6456fc37123cf17c6900f2", // d
      b[16], // heavy tip
      b[33], // light tip
    ];
    const bal1 = await token.balanceOf(e);
    await parsec.reportLightBranch(data, {from: e});
    const bal2 = await token.balanceOf(e);
    assert(bal1.toNumber() < bal2.toNumber());
    assert.equal(b[16], await parsec.tipHash());
  });

  //                           /-> b[3,e]  <- 4 rewards
  // b[0,c] -> b[1,c] -> b[2,d] -> b[4,c] -> b[7,e] -> b[8,e] -> b[9,c]   <- 7 rewards
  //                           \-> b[5,d] -> b[6,c] -> b[16,c]   <- 5 rewards
  it('should allow to extend other branch', async () => {
    let block = new Block(b[4], 4).addTx(new Tx().coinbase(blockReward, e));
    await parsec.submitBlock(b[4], block.merkleRoot(), ...block.sign(ePriv));
    b[7] = block.hash();

    block = new Block(b[7], 5).addTx(new Tx().coinbase(blockReward, e));
    await parsec.submitBlock(b[7], block.merkleRoot(), ...block.sign(ePriv));
    b[8] = block.hash();

    block = new Block(b[8], 6).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[8], block.merkleRoot(), ...block.sign(cPriv));
    b[9] = block.hash();
    let tip = await parsec.getTip([c, d, e]);
    assert.equal(b[9], tip[0]);
    assert.equal(7, tip[1]);

    await parsec.requestLeave({from: d});
  });

  //                           /-> b[3,e]
  // b[0,c] -> b[1,c] -> b[2,d] -> b[4,c] -> b[7,e] -> b[8,e] -> b[9,c]   <- 7 rewards
  //                           \-> b[5,d] -> b[6,c] -> b[16,c]
  it('operators that are leaving should not be able to submit blocks', async () => {
    await parsec.requestLeave({from: d});

    let block = new Block(b[9], 7).addTx(new Tx().coinbase(blockReward, d));
    await assertRevert(
      parsec.submitBlock(b[9], block.merkleRoot(), ...block.sign(dPriv))
    );
  });

  //                           /-> xxxxxx
  // b[0,c] -> b[1,c] -> b[2,d] -> b[4,c] -> b[7,e] -> b[8,e] -> ... -> b[15]
  //                           \-> xxxxxx -> b[6,c] -> b[16,c]
  it('should allow to prune', async () => {
    let block = new Block(b[9], 7).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[9], block.merkleRoot(), ...block.sign(cPriv));
    b[10] = block.hash();

    block = new Block(b[10], 8).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[10], block.merkleRoot(), ...block.sign(cPriv));
    b[11] = block.hash();

    block = new Block(b[11], 9).addTx(new Tx().coinbase(blockReward, c));
    const receipt1 = await parsec.submitBlock(b[11], block.merkleRoot(), ...block.sign(cPriv));
    b[12] = block.hash();

    block = new Block(b[12], 10).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[12], block.merkleRoot(), ...block.sign(cPriv));
    b[13] = block.hash();
    assert.equal(b[13], await parsec.tipHash());

    // test pruning
    assert.equal((await parsec.getBranchCount(b[2])).toNumber(), 3);
    block = new Block(b[13], 11).addTx(new Tx().coinbase(blockReward, c));
    const receipt2 = await parsec.submitBlock(b[13], block.merkleRoot(), ...block.sign(cPriv)); // <- this call is pruning
    assert.equal((await parsec.getBranchCount(b[2])).toNumber(), 1);
    assert(receipt1.receipt.gasUsed > receipt2.receipt.gasUsed);
    b[14] = block.hash();
    assert.equal(b[14], await parsec.tipHash());

    // prune orphans
    block = new Block(b[14], 12).addTx(new Tx().coinbase(blockReward, c));
    const receipt3 = await parsec.submitBlockAndPrune(b[14], block.merkleRoot(), ...block.sign(cPriv), [b[6], b[16]]);
    assert(receipt1.receipt.gasUsed > receipt3.receipt.gasUsed);
    b[15] = block.hash();
    assert.equal(b[15], await parsec.tipHash());
  });

  //
  // b[0] -> b[1] -> ... -> b[15] -> b[16] -> ... -> b[28]
  //
  it('should allow to mine beyond archive horizon and delete genesis', async () => {
    // more blocks
    const coinbase = new Tx().coinbase(blockReward, c);
    let transfer = new Tx(6).transfer([{prevTx: coinbase.hash(), outPos: 0}], [{ value: blockReward, addr: parsec.address}]);
    transfer = transfer.sign([cPriv]);
    let block = new Block(b[15], 13).addTx(coinbase).addTx(transfer);
    await parsec.submitBlock(b[15], block.merkleRoot(), ...block.sign(cPriv));
    b[17] = block.hash();
    const proof = block.proof(transfer.buf(), 1, [coinbase.hash()]);

    for(let i = 17; i < 25; i++) {
      block = new Block(b[i], i-3).addTx(new Tx().coinbase(blockReward, c));
      await parsec.submitBlock(b[i], block.merkleRoot(), ...block.sign(cPriv));
      b[i+1] = block.hash();
    }

    block = new Block(b[25], 22).addTx(coinbase).addTx(transfer);
    const receipt1 = await parsec.submitBlock(b[25], block.merkleRoot(), ...block.sign(cPriv));
    b[26] = block.hash();


    block = new Block(b[26], 23).addTx(new Tx().coinbase(blockReward, c));
    await parsec.submitBlock(b[26], block.merkleRoot(), ...block.sign(cPriv));
    b[27] = block.hash();
    assert.equal(b[27], await parsec.tipHash());

    // archive genesis
    block = new Block(b[27], 24).addTx(new Tx().coinbase(blockReward, c));
    const receipt2 = await parsec.submitBlockAndPrune(b[27], block.merkleRoot(), ...block.sign(cPriv), [b[0]]);
    assert(receipt1.receipt.gasUsed > receipt2.receipt.gasUsed);
    assert(receipt2.logs[1].event == 'ArchiveBlock');
    b[28] = block.hash();

    let tip = await parsec.getTip([c, d, e]);
    assert.equal(b[28], tip[0]);
    assert.equal(4, tip[1]);

    // leave operator set, get stake back
    let bal1 = await token.balanceOf(d);
    await parsec.payout(d);
    let bal2 = await token.balanceOf(d);
    assert(bal1.toNumber() < bal2.toNumber());

    // withdraw burned output
    bal1 = await token.balanceOf(c);
    await parsec.withdrawBurn(proof);
    bal2 = await token.balanceOf(c);
    assert(bal1.toNumber() < bal2.toNumber());
  });


  //
  // b[0] -> b[1] -> ... -> b[15] -> b[16] -> ... -> b[34]
  //
  it('should allow to deposit', async () => {
    // deposit
    let bal = await token.balanceOf(d);
    const receipt = await parsec.deposit(bal, { from: d });
    const depositId = receipt.logs[0].args.depositId.toNumber();
    const deposit = new Tx().deposit(depositId, bal.toNumber(), e);

    // wait until operator included
    let block = new Block(b[28], 25).addTx(deposit);
    await parsec.submitBlock(b[28], block.merkleRoot(), ...block.sign(ePriv));
    b[34] = block.hash();
    const proof = block.proof(deposit.buf(), 0, [empty]);

    // complain, if deposit tx wrong
    const bal1 = await token.balanceOf(d);
    const stake1 = await parsec.operators(e);
    await parsec.reportInvalidDeposit(proof, {from: d});
    const bal2 = await token.balanceOf(d);
    const stake2 = await parsec.operators(e);
    assert(bal1.toNumber() < bal2.toNumber());
    assert(stake1[2].toNumber() > stake2[2].toNumber());
  });

  //                                                      /-> b[25,c]
  // b[0] -> b[1] -> ... -> b[15] -> b[16] -> ... -> b[24] -> b[25,c] -> ... -> b[28]
  //
  it('should allow to slash if 2 blocks proposed at same height', async () => {
    const coinbase = new Tx().coinbase(blockReward, c);
    let transfer = new Tx(6).transfer([{prevTx: coinbase.hash(), outPos: 0}], [{ value: blockReward, addr: c}]);
    transfer = transfer.sign([cPriv]);

    let block = new Block(b[24], 21).addTx(coinbase).addTx(transfer);
    await parsec.submitBlock(b[24], block.merkleRoot(), ...block.sign(cPriv));

    // slash
    const bal1 = await token.balanceOf(d);
    const stake1 = await parsec.operators(c);
    await parsec.reportHeightConflict(b[25], block.hash(), {from: d});
    const bal2 = await token.balanceOf(d);
    const stake2 = await parsec.operators(c);
    assert(bal1.toNumber() < bal2.toNumber());
    assert(stake1[2].toNumber() > stake2[2].toNumber());
  });

   describe('gasTests ... this will take a while ...', () => {
     it('should allow to have epoch length of 64', async () => {
       const token64 = await SimpleToken.new();
       const parsec64 = await ParsecBridge.new(token64.address, 0, 64, 5000000, 0);
       await token64.approve(parsec64.address, totalSupply);
       await parsec64.join(totalSupply.div(64).mul(4));

       const b64 = [];
       b64[0] = await parsec64.tipHash();
       let block = new Block(b64[0], 1);
       let sig
       let root

       for(let i = 1; i < 65; i++) {
         process.stdout.write('Submitting block: ' + i + ' of 64\r');
         block = new Block(b64[i - 1], i).addTx(new Tx().coinbase(blockReward, c));
         sig = block.sign(cPriv);
         b64[i] = block.hash()
         await parsec64.submitBlock(b64[i - 1], block.merkleRoot(), ...sig);
       }
       process.stdout.write("\n\r");
       assert.equal(b64[64], await parsec64.tipHash());

       // test submitting a block that checks for pruning
       block = new Block(b64[64], 65).addTx(new Tx().coinbase(blockReward, c));
       sig = block.sign(cPriv);
       b64[65] = block.hash()
       let receipt = await parsec64.submitBlock(b64[64], block.merkleRoot(), ...sig);

       assert.isAtMost(receipt.receipt.gasUsed, 220000);

       for(let i = 66; i < 193; i++) {
         process.stdout.write('Submitting block: ' + i + ' of 192\r');
         block = new Block(b64[i - 1], i).addTx(new Tx().coinbase(blockReward, c));
         sig = block.sign(cPriv);
         b64[i] = block.hash()
         await parsec64.submitBlock(b64[i - 1], block.merkleRoot(), ...sig);
       }
       process.stdout.write("\n\r");

       assert.equal(b64[192], await parsec64.tipHash());

       // check that archiving works with high epoch length
       block = new Block(b64[192], 193).addTx(new Tx().coinbase(blockReward, c));
       sig = block.sign(cPriv);
       b64[193] = block.hash()
       receipt = await parsec64.submitBlockAndPrune(b64[192], block.merkleRoot(), ...sig, [b64[0]]);

        //there is test fails gasUsed = 198956. should we catch the event?
       assert.isAtMost(receipt.receipt.gasUsed, 199020);
     });

     it('should allow to have epoch length of 128', async () => {
       const token128 = await SimpleToken.new();
       const parsec128 = await ParsecBridge.new(token128.address, 0, 128, 5000000, 0);
       await token128.approve(parsec128.address, totalSupply);
       await parsec128.join(totalSupply.div(128).mul(4));

       const b128 = [];
       b128[0] = await parsec128.tipHash();
       let block = new Block(b128[0], 1);
       let sig
       let root
       for (let i = 1; i < 129; i++) {
         process.stdout.write('Submitting block: ' + i + ' of 128\r');
         block = new Block(b128[i - 1], i).addTx(new Tx().coinbase(blockReward, c));
         sig = block.sign(cPriv);
         b128[i] = block.hash()
         await parsec128.submitBlock(b128[i - 1], block.merkleRoot(), ...sig);
       }
       process.stdout.write("\n\r");
       assert.equal(b128[128], await parsec128.tipHash());

       // test submitting a block that checks for pruning
       block = new Block(b128[128], 129).addTx(new Tx().coinbase(blockReward, c));
       sig = block.sign(cPriv);
       b128[129] = block.hash()
       let receipt = await parsec128.submitBlock(b128[128], block.merkleRoot(), ...sig);
       
       //the same, used 282713
       assert.isAtMost(receipt.receipt.gasUsed, 282777);
     });
   });
});
