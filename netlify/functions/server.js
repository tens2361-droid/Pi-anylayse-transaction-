const axios = require('axios');
const StellarSdk = require('stellar-sdk');

exports.handler = async (event, context) => {
    // Sirf POST request allow karne ke liye
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { input } = JSON.parse(event.body);
        if (!input) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Input missing' }) };
        }

        let targetAddress = input.trim();

        // 1. Passphrase to Public Key conversion
        if (targetAddress.includes(" ")) {
            try {
                const seed = StellarSdk.Util.Mnemonic.toSeed(targetAddress);
                const keypair = StellarSdk.Keypair.fromSecret(StellarSdk.StrKey.encodeEd25519SecretSeed(seed));
                targetAddress = keypair.publicKey();
            } catch (err) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Invalid passphrase syntax.' }) };
            }
        }

        if (!targetAddress.startsWith("G") || targetAddress.length !== 56) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Target key must be exactly 56 chars starting with G.' }) };
        }

        // 2. Fetch from Pi Mainnet
        let targetUrl = `https://api.mainnet.minepi.com/accounts/${targetAddress}/operations?limit=100&order=desc`;
        let mixedDataset = {};
        let globalStats = { total: 0, success: 0, failed: 0 };

        const nodeResponse = await axios.get(targetUrl, { timeout: 10000 });
        
        if (nodeResponse.data && nodeResponse.data._embedded && nodeResponse.data._embedded.records) {
            const records = nodeResponse.data._embedded.records;

            records.forEach(op => {
                if (op.type !== 'payment' && op.type !== 'create_account') return;

                globalStats.total++;
                let isSuccess = op.transaction_successful === undefined ? true : op.transaction_successful;

                if (isSuccess) globalStats.success++;
                else globalStats.failed++;

                let interactionPeer = (op.from && op.from !== targetAddress) ? op.from : (op.to || op.account || "Core_Handshake");
                let calculatedFee = op.fee_charged ? (parseFloat(op.fee_charged) / 10000000) : 0.01;

                if (!mixedDataset[interactionPeer]) {
                    mixedDataset[interactionPeer] = { total: 0, success: 0, failed: 0, maxFee: 0 };
                }

                mixedDataset[interactionPeer].total++;
                if (isSuccess) mixedDataset[interactionPeer].success++;
                else mixedDataset[interactionPeer].failed++;

                if (calculatedFee > mixedDataset[interactionPeer].maxFee) {
                    mixedDataset[interactionPeer].maxFee = calculatedFee;
                }
            });
        }

        const finalRows = Object.keys(mixedDataset).map(peer => ({
            address: peer,
            total: mixedDataset[peer].total,
            success: mixedDataset[peer].success,
            failed: mixedDataset[peer].failed,
            maxFee: mixedDataset[peer].maxFee.toFixed(5)
        }));

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targetAddress, globalStats, rows: finalRows })
        };

    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Pi Node pipeline timeout or network restriction.' })
        };
    }
};
