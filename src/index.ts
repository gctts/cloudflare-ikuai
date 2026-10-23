import {App} from "./App";
import winston from "winston";
import env from 'dotenv'
import {ServiceConfigs} from "./configs/ServiceConfigs";
import fs from 'fs'
import moment from 'moment-timezone'
env.config({path:'./configs/service.env'});

const configs: ServiceConfigs = {

    POOL_SIZE: Number(process.env.CANDIDATE_POOL_SIZE || 64),
    EXPLORE_NUM: Number(process.env.EXPLORE_NUM || 32),
    DOMAIN_CANDIDATES: Number(process.env.DOMAIN_CANDIDATE_NUM || 24),
    DOMAIN_TESTS: Number(process.env.DOMAIN_TESTS || 3),
    DOMAIN_TIMEOUT: Number(process.env.DOMAIN_TIMEOUT_MS || 2000),
    DOMAIN_CONCURRENCY: Number(process.env.DOMAIN_CONCURRENCY || 32),
    DOMAIN_TIME_LIMIT: Number(process.env.DOMAIN_TIME_LIMIT || 2000),
    ENABLE_V6: process.env.ENABLE_V6 === 'true',
    CRON: process.env.CRON || '0 * * * *',
    ROUTER_USERNAME: process.env.ROUTER_USERNAME || '',
    ROUTER_PASSWORD: process.env.ROUTER_PASSWORD || '',
    ROUTER_IP: process.env.ROUTER_IP || '',
    ROUTER_PORT: Number(process.env.ROUTER_PORT || 80),
    DN: Number(process.env.DOWNLOAD_NUM || 0),
    TL: Number(process.env.TIME_LIMIT || 1000),
    TLL: Number(process.env.TIME_LOWER_LIMIT || 0),
    TLR: Number(process.env.LOSS_RATE ?? 0.2),
    SL: Number(process.env.SPEED_LIMIT || 0),
    SELECT_NUM: Number(process.env.SELECT_NUM || 3),
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    SCRIPT_LINUX:'CloudflareST',
    SCRIPT_WIN:'CloudflareST.exe',
    FILE:'result.csv',
    FILE6:'result6.csv',
    TZ: process.env.TZ||'Asia/Shanghai',

    DT: Number(process.env.DOWNLOAD_TIME),
    DD:process.env.DISABLE_DOWNLOAD!=='false',
    HTTPING_CODE:Number(process.env.HTTP_PING_CODE || 204),
    HTTPING:process.env.HTTP_PING!=='false',
    ALLIP:process.env.ALL_IP==='true',
    CF_COLO:process.env.CF_COLO||'',
    N: Number(process.env.THREAD || 100),
    T: Number(process.env.DELAYED_TESTS || 2),
    TP: Number(process.env.TEST_PORT || 443),
    URL: process.env.URL || 'https://cp.cloudflare.com/generate_204',


};

for (const [name, value, min, max] of [
    ['SELECT_NUM', configs.SELECT_NUM, 1, 10], ['CANDIDATE_POOL_SIZE', configs.POOL_SIZE, 3, 1000],
    ['EXPLORE_NUM', configs.EXPLORE_NUM, 0, 1000], ['DOMAIN_CANDIDATE_NUM', configs.DOMAIN_CANDIDATES, configs.SELECT_NUM, configs.POOL_SIZE],
    ['DOMAIN_TESTS', configs.DOMAIN_TESTS, 2, 10], ['DOMAIN_TIMEOUT_MS', configs.DOMAIN_TIMEOUT, 100, 30000],
    ['DOMAIN_CONCURRENCY', configs.DOMAIN_CONCURRENCY, 1, 128], ['DOMAIN_TIME_LIMIT', configs.DOMAIN_TIME_LIMIT, 1, 30000],
    ['TEST_PORT', configs.TP, 1, 65535]
] as Array<[string, number, number, number]>) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
}
if (!Number.isFinite(configs.TLR) || configs.TLR < 0 || configs.TLR > 1) throw new Error('LOSS_RATE 必须为 0–1');
fs.mkdirSync('./logs', {recursive: true});
const log=winston.createLogger({
    level: configs.LOG_LEVEL,
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            const shanghaiTime = moment(timestamp as string).tz(configs.TZ).format('YYYY-MM-DD HH:mm:ss:SSS')
            return `${shanghaiTime} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: './logs/app.log' })
    ]
});

log.debug("配置："+JSON.stringify({...configs, ROUTER_PASSWORD:"[已隐藏]"}))
new App(log,configs).main()