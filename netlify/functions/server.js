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

        // 1. Passphrase check (Agar spaces hain)
        if (mainWalletAddress.includes(" ")) {
            const wordsArray = mainWalletAddress.split(/\s+/); // Words ko count karne ke liye
            
            // Agar 24 words se kam hain, toh saaf error do
            if (wordsArray.length < 24) {
                return { 
                    statusCode: 400, 
                    body: JSON.stringify({ error: `Aapne sirf ${wordsArray.length} words type kiye hain. Pi Network ka passphrase poore 24 words ka hota hai. Kripya poora passphrase daalein ya fir Public Address (G...) daalein.` }) 
                };
            }

            try {
                // Agar poore 24 words hain, toh unhe decode karo
                const seed = StellarSdk.Util.Mnemonic.toSeed(mainWalletAddress);
                const keypair = StellarSdk.Keypair.fromSecret(StellarSdk.StrKey.encodeEd25519SecretSeed(seed));
                mainWalletAddress = keypair.publicKey();
            } catch (err) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Poore 24 words hain, par kisi word ki spelling galat hai ya sequence Pi standard ka nahi hai.' }) };
            }
        }

        // 2. Strict character evaluation for exact mainnet standards (G... aur 56 chars)
        if (!mainWalletAddress.startsWith("G") || mainWalletAddress.length !== 56) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Address: Wallet Address "G" se shuru hona chahiye aur theek 56 characters ka hona chahiye.' }) };
        }

        let mixedDataset = {};
        let globalStats = { total: 0, success: 0, failed: 0 };

        // 3. Direct Mainnet URL (100 limit ke sath taaki bot attacks scan ho sakein)
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
            // Sirf payment aur create_account track karenge jahan bot ne try kiya
            if (op.type !== 'payment' && op.type !== 'create_account') return;

            globalStats.total++;
            let isSuccess = op.transaction_successful === undefined ? true : op.transaction_successful;

            if (isSuccess) globalStats.success++;
            else globalStats.failed++;

            // Bot (Receiving/Interacting Address) ko track karna
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
            body: JSON.stringify({ error: 'Pi Network Mainnet Node is responding slow or blocked your network request. Please try again.' })
        };
    }
};
