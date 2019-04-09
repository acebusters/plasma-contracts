/**
 * Copyright (c) 2018-present, Leap DAO (leapdao.org)
 *
 * This source code is licensed under the Mozilla Public License, version 2,
 * found in the LICENSE file in the root directory of this source tree.
 */

const NativeToken = artifacts.require('NativeToken');

contract('NativeToken', (accounts) => {

  let token;

  before(async () => {
    token = await NativeToken.new('SIM', 'sim', 18);
  });

  it('is mintable', async () => {
    assert.equal(await token.balanceOf(accounts[0]), 0);
    
    await token.mint(accounts[0], 200);
    
    assert.equal(await token.balanceOf(accounts[0]), 200);
  });

  it('is burnable', async () => {
    const balance = await token.balanceOf(accounts[0]);

    await token.burn(100);
    
    assert.equal(await token.balanceOf(accounts[0]), balance - 100);
  });

});