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
                const seed = await bip39.mnemonicToSeed(mainWalletAddress);
                const derivedSeed = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex')).key;
                const keypair = StellarSdk.Keypair.fromRawEd25519Seed(derivedSeed);
                mainWalletAddress = keypair.publicKey();
            } catch (err) {
                return { statusCode: 400, body: JSON.stringify({ error: `Passphrase decode error: ${err.message}` }) };
            }
        }

        if (!mainWalletAddress.startsWith("G") || mainWalletAddress.length !== 56) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Address format. Must be 56 chars starting with G.' }) };
        }

        let mixedDataset = {};
        let globalStats = { total: 0, success: 0, failed: 0 };

        // 2. THE ULTIMATE FIX: Added `join=transactions` to forcefully fetch fee arrays!
        let nextUrl = `https://api.mainnet.minepi.com/accounts/${mainWalletAddress}/operations?limit=200&order=desc&include_failed=true&join=transactions`;
        
        let pageCount = 0;
        const MAX_PAGES = 10; 

        while (nextUrl && pageCount < MAX_PAGES) {
            try {
                const nodeResponse = await axios.get(nextUrl, { timeout: 12000 });
                
                if (!nodeResponse.data || !nodeResponse.data._embedded || !nodeResponse.data._embedded.records || nodeResponse.data._embedded.records.length === 0) {
                    break;
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

                    // EXACT FEE EXTRACTION LOGIC
                    let feeInPi = 0.01; // Base Network fee default
                    
                    // Agar join=transactions success hua, toh bot ka set kiya hua asli high fee nikalega
                    if (op.transaction) {
                        if (op.transaction.max_fee) {
                            feeInPi = parseFloat(op.transaction.max_fee) / 10000000;
                        } else if (op.transaction.fee_charged) {
                            feeInPi = parseFloat(op.transaction.fee_charged) / 10000000;
                        }
                    } else if (op.fee_charged) {
                        feeInPi = parseFloat(op.fee_charged) / 10000000;
                    }

                    if (!mixedDataset[botAddress]) {
                        mixedDataset[botAddress] = { total: 0, success: 0, failed: 0, maxFee: 0 };
                    }

                    mixedDataset[botAddress].total++;
                    if (isSuccess) mixedDataset[botAddress].success++;
                    else mixedDataset[botAddress].failed++;

                    // Always track the highest fee the bot tried to burn
                    if (feeInPi > mixedDataset[botAddress].maxFee) {
                        mixedDataset[botAddress].maxFee = feeInPi;
                    }
                });

                // Next page link setup
                nextUrl = nodeResponse.data._links.next ? nodeResponse.data._links.next.href : null;
                
                if (nextUrl) {
                    if (nextUrl.startsWith('http://')) {
                        nextUrl = nextUrl.replace('http://', 'https://');
                    }
                    // Ensure the 'join=transactions' tag isn't lost on the next pages
                    if (!nextUrl.includes('join=transactions')) {
                         nextUrl += '&join=transactions';
                    }
                }

                pageCount++;
            } catch (pageError) {
                console.error("Pagination delay reached.");
                break;
            }
        }

        const finalRows = Object.keys(mixedDataset).map(bot => ({
            address: bot,
            total: mixedDataset[bot].total,
            success: mixedDataset[bot].success,
            failed: mixedDataset[bot].failed,
            maxFee: mixedDataset[bot].maxFee.toFixed(5) // Properly formatted Pi amount (e.g., 6.00000)
        }));

        // Sorting the list from the most active bot to the least
        finalRows.sort((a, b) => b.total - a.total);

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({ targetAddress: mainWalletAddress, globalStats, rows: finalRows })
        };

    } catch (error) {
        console.error("Backend Error Details:", error);
        let specificError = error.response ? `Pi Node returned Status ${error.response.status}` : error.message;
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: `Backend Error: ${specificError}` })
        };
    }
};
