const axios = require('axios');
const StellarSdk = require('stellar-sdk');
const bip39 = require('bip39');
const ed25519 = require('ed25519-hd-key');

exports.handler = async (event, context) => {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const { input } = JSON.parse(event.body);
        if (!input) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Input wallet details missing.' }) };
        }

        let mainWalletAddress = input.trim();

        // 1. ASLI PI NETWORK PASSPHRASE DECODER
        if (mainWalletAddress.includes(" ")) {
            const wordsArray = mainWalletAddress.split(/\s+/);
            
            if (wordsArray.length < 24) {
                return { statusCode: 400, body: JSON.stringify({ error: `Aapne sirf ${wordsArray.length} words type kiye hain. Poore 24 words daalein.` }) };
            }

            try {
                // Sahi tarika Pi ke words ko convert karne ka
                const seed = await bip39.mnemonicToSeed(mainWalletAddress);
                const derivedSeed = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex')).key;
                const keypair = StellarSdk.Keypair.fromRawEd25519Seed(derivedSeed);
                mainWalletAddress = keypair.publicKey();
            } catch (err) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Passphrase decode nahi ho paaya. Kripya Public Address (G...) try karein.' }) };
            }
        }

        if (!mainWalletAddress.startsWith("G") || mainWalletAddress.length !== 56) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Address format.' }) };
        }

        let mixedDataset = {};
        let globalStats = { total: 0, success: 0, failed: 0 };

        let mainnetUrl = `https://api.mainnet.minepi.com/accounts/${mainWalletAddress}/operations?limit=100&order=desc`;
        let finalApiUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(mainnetUrl)}`;

        const nodeResponse = await axios.get(finalApiUrl, { timeout: 20000 });
        
        if (!nodeResponse.data || !nodeResponse.data._embedded || !nodeResponse.data._embedded.records) {
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ targetAddress: mainWalletAddress, globalStats, rows: [] })
            };
        }

        const records = nodeResponse.data._embedded.records;

        records.forEach(op => {
            if (op.type !== 'payment' && op.type !== 'create_account') return;

            globalStats.total++;
            let isSuccess = op.transaction_successful === undefined ? true : op.transaction_successful;

            if (isSuccess) globalStats.success++;
            else globalStats.failed++;

            let botAddress = "";
            if (op.from && op.from !== mainWalletAddress) {
                botAddress = op.from;
            } else {
                botAddress = op.to || op.account || "Core_System_Contract";
            }

            let feeInPi = op.fee_charged ? (parseFloat(op.fee_charged) / 10000000) : 0.01;

            if (!mixedDataset[botAddress]) {
                mixedDataset[botAddress] = { total: 0, success: 0, failed: 0, maxFee: 0 };
            }

            mixedDataset[botAddress].total++;
            if (isSuccess) mixedDataset[botAddress].success++;
            else mixedDataset[botAddress].failed++;

            if (feeInPi > mixedDataset[botAddress].maxFee) {
                mixedDataset[botAddress].maxFee = feeInPi;
            }
        });

        const finalRows = Object.keys(mixedDataset).map(bot => ({
            address: bot,
            total: mixedDataset[bot].total,
            success: mixedDataset[bot].success,
            failed: mixedDataset[bot].failed,
            maxFee: mixedDataset[bot].maxFee.toFixed(5)
        }));

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type"
            },
            body: JSON.stringify({ targetAddress: mainWalletAddress, globalStats, rows: finalRows })
        };

    } catch (error) {
        console.error(error.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Pi Network Mainnet Node request failed. Try again.' })
        };
    }
};
