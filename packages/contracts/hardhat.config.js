require('@nomicfoundation/hardhat-toolbox');

const { BASE_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    compilers: [
      {
        version: '0.8.24',
        settings: {
          viaIR: true,
          optimizer: { enabled: true, runs: 200 }
        }
      }
    ]
  },
  networks: {
    ...(BASE_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? {
          base: {
            url: BASE_RPC_URL,
            accounts: [DEPLOYER_PRIVATE_KEY]
          }
        }
      : {})
  }
};
