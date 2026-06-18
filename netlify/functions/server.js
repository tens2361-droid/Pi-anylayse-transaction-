const axios = require('axios');
const StellarSdk = require('stellar-sdk');

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

        // 1. Agar passphrase dala hai toh use strictly convert karo bina kisi fallback ke
        if (mainWalletAddress.includes(" ")) {
            try {
                const seed = StellarSdk.Util.Mnemonic.toSeed(mainWalletAddress);
                const keypair = StellarSdk.Keypair.fromSecret(StellarSdk.StrKey.encodeEd25519SecretSeed(seed));
                mainWalletAddress = keypair.publicKey();
            } catch (err) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Passphrase galat hai ya words sahi nahi hain.' }) };
            }
        }

        // 2. Strict character evaluation for exact mainnet standards
        if (!mainWalletAddress.startsWith("G") || mainWalletAddress.length !== 56) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Wallet Address G se shuru hona chahiye aur 56 chars ka hona chahiye.' }) };
        }

        let mixedDataset = {};
        let globalStats = { total: 0, success: 0, failed: 0 };

        // 3. Direct Mainnet URL (Hum isme limit=100 rakhenge taaki saare bot attacks scan ho sakein)
        let mainnetUrl = `https://api.mainnet.minepi.com/accounts/${mainWalletAddress}/operations?limit=100&order=desc`;
        
        // CORS proxy bypass router with maximum network timeout configuration
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
            // Hum sirf payment aur account creation operations check karenge jahan bot transactions hit hue the
            if (op.type !== 'payment' && op.type !== 'create_account') return;

            globalStats.total++;
            let isSuccess = op.transaction_successful === undefined ? true : op.transaction_successful;

            if (isSuccess) globalStats.success++;
            else globalStats.failed++;

            // ASLI FIX: Hum un bots (Receiving/Interacting Addresses) ko track kar rahe hain jinhone is wallet par attack kiya tha
            let botAddress = "";
            if (op.from && op.from !== mainWalletAddress) {
                botAddress = op.from; // Agar bot ne paise bheje ya gas lagayi
            } else {
                botAddress = op.to || op.account || "Core_System_Contract"; // Jis bot address par paise transfer karne ki koshish ki gayi
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

        // Data array parsing for client UI display
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
            body: JSON.stringify({ error: 'Pi Network Mainnet Node is responding slow or blocked your local network range.' })
        };
    }
};
