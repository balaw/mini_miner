
// https://gist.github.com/tweinfeld/b28e9b8b22b4a17bdc96e284eecb92f0

const
    _ = require('lodash'),
    kefir = require('kefir'),
    net = require('net'),
    https = require('https'),
    bigInt = require('big-integer'),
    { createHash } = require('crypto');

const
    LOGGLY_API_KEY = "b8d2377d-63d8-4f4c-ae07-fb05bb999b3c",
    TERMINATION_TIMER = 1000 * 60,
    DIFFICULTY_1 = bigInt('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 16),
    CONNECTION_RETRIAL_COUNT = 20,
    POOLS = _.shuffle([
        {
            hostname: "us-east.stratum.slushpool.com",
            port: 3333,
            user: "jeffrycoal"
        }, {
            hostname: "eu.stratum.slushpool.com",
            port: 3333,
            user: "jeffrycoal"
        }, {
            hostname: "sg.stratum.slushpool.com",
            port: 3333,
            user: "jeffrycoal"
        }, {
            hostname: "jp.stratum.slushpool.com",
            port: 3333,
            user: "jeffrycoal1"
        }
    ]),
    WORKER_ID = Math.random().toString(36).split('').slice(2).join('');

let log = (function(){
    const
        localDispatcher = (level, ...message)=> console[{ "trace": "log" }[level] || level](...message),
        logglyDispatcher = (level, ...message)=> https.get(`https://logs-01.loggly.com/inputs/${LOGGLY_API_KEY}.gif?source=${WORKER_ID}&type=${level}&data=${encodeURIComponent(message.join(' '))}`),
        dispatcherMap = {
            "info": [localDispatcher, logglyDispatcher],
            "warn": [localDispatcher, logglyDispatcher],
            "trace": [localDispatcher]
        };

    return _.keys(dispatcherMap).map((name)=>({ [name]: (...args)=> dispatcherMap[name].forEach((dispatcher)=> dispatcher(name, ...args)) })).reduce(_.assign);
})();

log.info('Started');
["SIGTERM", "SIGINT"].forEach((signal)=> process.on(signal, ()=> { log.warn('Received request for termination'); process.exit(0); }));

const
    dsha256 = (function(sha256){ return _.flow(sha256, sha256); })((input)=> createHash('sha256').update(input).digest()),
    iteratorFactory = (difficulty, merkleTree, extraNonceOne, extraNonce2Size, coinBaseA, coinBaseB, previousBlock, blockVersion, nBits, nTime)=> {
        const target = DIFFICULTY_1.divide(difficulty);
        const createCoinBaseHashMerkle = _.memoize((extraNonce2)=> {
            let coinBase = [coinBaseA, extraNonceOne, _.padStart(extraNonce2.toString(16), extraNonce2Size * 2, '0'), coinBaseB].join(''),
                coinBaseHash = dsha256(Buffer.from(coinBase, 'hex')).toString('hex');

            return merkleTree.reduce((a, c)=> dsha256(Buffer.from([a, c].join(''), 'hex')).toString('hex'), coinBaseHash);
        });

        return (start, iterations)=> {
            let index = bigInt(start),
                end = bigInt(start).add(bigInt(iterations));

            log.trace(`Sweeping range ${[index, end].map((n)=> n.toString(16)).join(' -> ') }`);

            while(index.lesser(end)){
                let nonce2 = index.divide(0xffffffff),
                    nonce = index.mod(0xffffffff),
                    header = [
                        blockVersion,
                        previousBlock,
                        createCoinBaseHashMerkle(nonce2),
                        nTime,
                        nBits,
                        _.padStart(nonce.toString(16), 8, '0')
                    ].join('');

                let headerHash = dsha256(Buffer.from(header, 'hex')).toString('hex');

                if(bigInt(_.chunk(headerHash,2).map((x)=> x.join('')).reverse().join(''), 16).lesser(target)){
                    return {
                        nonce: _.padStart(nonce.toString(16), 8, '0'),
                        nonce2: _.padStart(nonce2.toString(16), extraNonce2Size * 2, '0'),
                        ntime: nTime
                    };
                }
                index = index.add(1);
            }
        };
    };

kefir.repeat((trialCount)=> {

    let pool = (function(p){ p.push(...p.splice(0, 1)); return p[0]; })(POOLS),
        client = net.createConnection(..._.at(pool, ["port", "hostname"]));

    return trialCount < CONNECTION_RETRIAL_COUNT && kefir
        .fromEvents(client, 'connect')
        .takeUntilBy(kefir.fromEvents(client, 'close').take(1))
        .flatMap(()=> {
            log.info(`Connected to "${pool["hostname"]}"`);
            let serverStream = kefir
                .fromEvents(client, 'data', (chunk)=> chunk.toString('utf8'))
                .flatMap((function(strBuffer){
                    return (txt)=> {
                        strBuffer += txt;
                        return kefir.sequentially(0,
                            (function(){
                                let arr = strBuffer.split('\n');
                                strBuffer = arr.splice(-1)[0];
                                return arr;
                            })()
                        );
                    };
                })(""))
                .map(JSON.parse)
                .takeUntilBy(kefir.fromEvents(client, 'end'))
                .onValue(_.noop);

            const invoke = (function(id){
                return (methodName, ...args)=> {
                    let commandId = id++;
                    client.write([JSON.stringify({ id: commandId, method: methodName, params: args }), "\n"].join(''));
                    return serverStream
                        .filter(_.matchesProperty('id', commandId))
                        .take(1)
                        .flatMap(({ error, result })=> (error || !result) ? kefir.constantError(error) : kefir.constant(result))
                        .takeErrors(1)
                        .toPromise();
                };
            })(0);

            let
                workerName = [pool["user"], WORKER_ID].join('.'),
                initializationProperty = kefir
                    .concat([
                        kefir.fromPromise(invoke('mining.subscribe', 'fastmine.ch')),
                        kefir
                            .fromPromise(invoke('mining.authorize', workerName))
                            .onValue(()=> log.info(`Authenticated as "${workerName}"`))
                            .ignoreValues()
                            .mapErrors(()=> `Authorization failed for "${workerName}"  ${pool["hostname"]}`)
                    ])
                    .toProperty();

            let
                extraNonceOneProperty = initializationProperty.map(_.property('1')),
                extraNonceTwoSizeProperty = initializationProperty.map(_.property('2')),
                jobProperty = serverStream.filter(_.matches({ "method": "mining.notify", id: null })).map(_.property('params')).toProperty(),
                difficultyProperty = serverStream.filter(_.matches({ "method": "mining.set_difficulty", id: null })).map(_.flow(_.property('params'), _.first)).toProperty(),
                jobId = jobProperty.map(_.property('0')),
                previousBlock = jobProperty.map(_.property('1')),
                coinBaseA = jobProperty.map(_.property('2')),
                coinBaseB = jobProperty.map(_.property('3')),
                merkleTree = jobProperty.map(_.property('4')),
                blockVersion = jobProperty.map(_.property('5')),
                nBits = jobProperty.map(_.property('6')),
                nTime = jobProperty.map(_.property('7')),
                clearFlag = jobProperty.map(_.property('8')).skipDuplicates();

            return kefir
                .combine([difficultyProperty, jobId, nTime, nBits, previousBlock, merkleTree, coinBaseA, coinBaseB, blockVersion, extraNonceTwoSizeProperty, extraNonceOneProperty, clearFlag])
                .debounce()
                .flatMapLatest(([difficulty, jobId, nTime, nBits, previousBlock, merkleTree, coinBaseA, coinBaseB, blockVersion, extraNonce2Size, extraNonceOne])=> {

                    log.trace(`New Job set (${jobId}) with difficulty ${difficulty}`);

                    let hashIterator = iteratorFactory(difficulty, merkleTree, extraNonceOne, extraNonce2Size, coinBaseA, coinBaseB, previousBlock, blockVersion, nBits, nTime),
                        domain = bigInt(0xffffffff).multiply(_.random(0xffffffff));

                    return kefir
                        .sequentially(0, _.range(0, 0xffffffff, 0xfff))
                        .map((sector)=> hashIterator(domain.add(sector), 0xfff))
                        .filter(Boolean)
                        .flatMap(({ nonce, nonce2, ntime })=>
                            kefir
                                .fromPromise(invoke('mining.submit', workerName, jobId, nonce2, ntime, nonce))
                                .map(()=> `PoW submitted ${jobId} => ${[nonce, nonce2, ntime].join('/')}`)
                        );
                });
        })
        .takeErrors(1)
        .beforeEnd(_.constant('Terminating'))
    })
    .onValue(log.info)
    .onError(log.warn);
