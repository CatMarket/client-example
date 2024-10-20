// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export import btc = require('bitcore-lib-inquisition')
import * as dotenv from 'dotenv'
dotenv.config()
const request = require('superagent')

import * as bitcoin from 'bitcoinjs-lib'
import * as secp256k1 from 'tiny-secp256k1'
import * as varuint from 'varuint-bitcoin'
import ECPairFactory from 'ecpair'
const ECPair = ECPairFactory(secp256k1)

bitcoin.initEccLib(secp256k1) 

const key = 'Bearer ' + process.env.MARKET_KEY
const privateKeyMain = btc.PrivateKey.fromWIF(process.env.PRIV_KEY)
const addressType = btc.Address.PayToTaproot
const network = 'livenet'
const baseUrl = process.env.BASE_URL || 'https://api.catmarket.io'

export function toXOnlyPubKeyBuf(pubKey: Buffer) {
    return pubKey.subarray(1)
}

export function serializeScript(s: Buffer): Buffer {
    const varintLen = varuint.encodingLength(s.length);
    const buffer = Buffer.allocUnsafe(varintLen); // better
    varuint.encode(s.length, buffer);
    return Buffer.concat([buffer, s]);
}

export function getAddressFromPublicKey(pubKey: btc.PublickKey, network: string, addressType: string) {
    return btc.Address.fromPublicKey(pubKey, network, addressType)
}

export function signPsbt(data: any, wif: string, network = bitcoin.networks.bitcoin) {
    // sign
    const keyPair = ECPair.fromWIF(wif, network);
    const tweakedSigner = keyPair.tweak(
        bitcoin.crypto.taggedHash('TapTweak', toXOnlyPubKeyBuf(keyPair.publicKey)),
    );

    // sign
    const psbts: bitcoin.Psbt[] = []
    for (let i = 0; i < data.psbts!.length; i++) {
        const psbtHex = data.psbts![i]
        const psbt = bitcoin.Psbt.fromHex(psbtHex)
        for (let j = 0; j < data.toSignInputs![i].length; j++) {
            const args = data.toSignInputs![i][j]
            const signer = args.disableTweakSigner === true ? keyPair : tweakedSigner
            const input = psbt.data.inputs[args.index]
            if (input.tapLeafScript) {
                const tapLeaf = psbt.data.inputs[args.index].tapLeafScript![0]
                const hash = bitcoin.crypto.taggedHash(
                    'TapLeaf',
                    Buffer.concat([Buffer.from([tapLeaf.leafVersion]), serializeScript(tapLeaf.script)]),
                );
                console.debug("signPsbt: sighash %s", hash.toString('hex'))
                psbt.signTaprootInput(args.index, signer, hash)
            } else {
                psbt.signInput(args.index, signer)
            }
        }
        psbts.push(psbt)
    }
    return psbts
}

export function extractSigs(psbts: bitcoin.Psbt[], toSignInputs: any[]) {

    const sigs: string[][] = []
    // extract sigs
    for (let i = 0; i < psbts.length; i++) {
        sigs.push(Array(psbts[i].data.inputs.length).fill(''))
        const psbt = psbts[i]
        for (let j = 0; j < toSignInputs[i].length; j++) {
            const index = toSignInputs[i][j].index
            const input = psbt.data.inputs[index]
            let sig
            if (input.tapLeafScript || input.tapKeySig) {
                sig = input.tapKeySig || input.tapScriptSig![0].signature
            } else {
                sig = input.partialSig![0].signature || Buffer.alloc(0)
            }
            sigs[i][index] = sig.toString('hex')
        }
    }
    return sigs
}

class Client {
    address: btc.Address
    pubKey: Buffer
    privateKey: btc.PrivateKey

    constructor() {
        this.privateKey = privateKeyMain
        this.address = getAddressFromPublicKey(privateKeyMain.publicKey, network, addressType)
        this.pubKey = privateKeyMain.publicKey.toBuffer()
    }

    async makeOrder(tokenId: string, tokenAmount: number, satoshis: number, orderType: string) {
        try {
            const res = await request.post(`${baseUrl}/makeOrder`).set('Authorization', key)
            .send({
                address: this.address.toString(),
                tokenId: tokenId,
                pubKey: this.pubKey.toString('hex'),
                orderType,
                tokenAmount: tokenAmount,
                satoshis: satoshis,
            })
            console.info('makeOrder result: %s', JSON.stringify(res.body, null, 2))

            if (res.body.code !== 0) {
                console.error('makeOrder failed: %s', res.body)
                return
            }


            const data = res.body.data

            const psbts = signPsbt(data, this.privateKey.toWIF())

            const sigs = extractSigs(psbts, data.toSignInputs)

            const makeRes = await request.post(`${baseUrl}/makeOrderSign`).set('Authorization', key).send({
                requestId: data.requestId,
                sigs: sigs
            })
            console.info('makeOrder result: %s', JSON.stringify(makeRes.body, null, 2))
        } catch (e) {
            console.error(e)
        }
    }

    async takeOrder(orderId: string) {
        try {
            const res = await request.post(`${baseUrl}/takeOrder`).set('Authorization', key).send({
                orderId: orderId,
                address: this.address.toString(),
                pubKey: this.pubKey.toString('hex'),
            })
            console.info('takeOrder result: %s', JSON.stringify(res.body, null, 2))

            if (res.body.code !== 0) {
                console.error('takeOrder failed: %s', res.body)
                return
            }

            const data = res.body.data

            const psbts = signPsbt(data, this.privateKey.toWIF())
            const sigs = extractSigs(psbts, data.toSignInputs)

            const takeRes = await request.post(`${baseUrl}/takeOrderSign`).set('Authorization', key).send({
                requestId: data.requestId,
                sigs: sigs
            })
            console.info('takeOrder result: %s', JSON.stringify(takeRes.body, null, 2))
        } catch (e) {
            console.error(e)
        }
    }

    async takeOrders(orderIds: string[]) {
        try {
            const res = await request.post(`${baseUrl}/takeOrders`).set('Authorization', key).send({
                orderIds: orderIds,
                address: this.address.toString(),
                pubKey: this.pubKey.toString('hex'),
            })
            console.info('takeOrders result: %s', JSON.stringify(res.body, null, 2))

            if (res.body.code !== 0) {
                console.error('takeOrders failed: %s', res.body)
                return
            }

            const data = res.body.data

            const psbts = signPsbt(data, this.privateKey.toWIF())
            const sigs = extractSigs(psbts, data.toSignInputs)

            const takeRes = await request.post(`${baseUrl}/takeOrdersSign`).set('Authorization', key).send({
                requestId: data.requestId,
                sigs: sigs
            })
            console.info('takeOrders result: %s', JSON.stringify(takeRes.body, null, 2))
        } catch (e) {
            console.error(e)
        }
    }

    async cancelOrder(orderId: string) {
        try {   
            const res = await request.post(`${baseUrl}/cancelOrder`).set('Authorization', key).send({
                orderId: orderId,
        })
            console.info('cancelSell result: %s', JSON.stringify(res.body, null, 2))

            if (res.body.code !== 0) {
                console.error('cancelSell failed: %s', res.body)
                return
            }

            const data = res.body.data

            const psbts = signPsbt(data, this.privateKey.toWIF())
            const sigs = extractSigs(psbts, data.toSignInputs)

            const cancelRes = await request.post(`${baseUrl}/cancelOrderSign`).set('Authorization', key).send({
                requestId: data.requestId,
                sigs: sigs
            })
            console.info('cancelSell result: %s', JSON.stringify(cancelRes.body, null, 2))
        } catch (e) {
            console.error(e)
        }
    }

    async buyLimit(tokenId: string, price: number, amount: number) {
        const res = await request.post(`${baseUrl}/buyLimit`).set('Authorization', key).send({
            address: this.address.toString(),
            pubKey: this.pubKey.toString('hex'),
            tokenId, 
            price, 
            satoshis: amount,
        })
        console.info('buyLimit result: %s', JSON.stringify(res.body, null, 2))

        if (res.body.code !== 0) {
            console.error('buyLimit failed: %s', res.body)
            return
        }

        const data = res.body.data

        const psbts = signPsbt(data, this.privateKey.toWIF())
        const sigs = extractSigs(psbts, data.toSignInputs)

        const buyRes = await request.post(`${baseUrl}/buyLimitSign`).set('Authorization', key).send({
            requestId: data.requestId,
            sigs: sigs
        })
        console.info('buyLimit result: %s', JSON.stringify(buyRes.body, null, 2))
    }

    async sellLimit(tokenId: string, price: number, amount: number) {
        const res = await request.post(`${baseUrl}/sellLimit`).set('Authorization', key).send({ 
            address: this.address.toString(),
            pubKey: this.pubKey.toString('hex'),
            tokenId, 
            price, 
            tokenAmount: amount
        })
        console.info('sellLimit result: %s', JSON.stringify(res.body, null, 2))

        if (res.body.code !== 0) {
            console.error('sellLimit failed: %s', res.body)
            return
        }

        const data = res.body.data

        const psbts = signPsbt(data, this.privateKey.toWIF())
        const sigs = extractSigs(psbts, data.toSignInputs)

        const sellRes = await request.post(`${baseUrl}/sellLimitSign`).set('Authorization', key).send({
            requestId: data.requestId,
            sigs: sigs
        })
        console.info('sellLimit result: %s', JSON.stringify(sellRes.body, null, 2))
    }
}

async function main() {

    const client = new Client()
    console.info('address: %s', client.address.toString())
    const op = process.argv[2]
    if (op == 'makesell') {
        const tokenId = process.argv[3]
        const tokenAmount = parseInt(process.argv[4]) || 5
        const satoshis = parseInt(process.argv[5]) || 1000000
        client.makeOrder(tokenId, tokenAmount, satoshis, 'sell')
    } else if (op == 'makebuy') {
        const tokenId = process.argv[3]
        const tokenAmount = parseInt(process.argv[4]) || 5
        const satoshis = parseInt(process.argv[5]) || 1000000
        client.makeOrder(tokenId, tokenAmount, satoshis, 'buy')
    } else if (op == 'take') {
        const orderId = process.argv[3]
        client.takeOrder(orderId)
    } else if (op == 'takeorders') {
        const orderIds = process.argv.slice(3)
        client.takeOrders(orderIds)
    } else if (op == 'cancel') {
        const orderId = process.argv[3]
        client.cancelOrder(orderId)
    } else if (op == 'buylimit') {
        const tokenId = process.argv[3]
        const price = parseInt(process.argv[4])
        const amount = parseInt(process.argv[5])
        client.buyLimit(tokenId, price, amount)
    } else if (op == 'selllimit') {
        const tokenId = process.argv[3]
        const price = parseInt(process.argv[4])
        const amount = parseInt(process.argv[5])
        client.sellLimit(tokenId, price, amount)
    }
}

main()