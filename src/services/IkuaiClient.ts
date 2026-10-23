import http from 'http';
import {createHash} from 'crypto';
import type {RouterClient} from './IkuaiDnsWriter';

export class IkuaiClient implements RouterClient {
    private cookie = '';
    constructor(private host: string, private port: number, private timeoutMs = 10000) {}

    public async login(username: string, password: string): Promise<void> {
        this.cookie = '';
        const response = await this.request('/Action/login', {
            username, passwd: createHash('md5').update(password).digest('hex'),
            pass: Buffer.from('salt_11' + password).toString('base64'), remember_password: ''
        });
        if (response.body.Result !== 10000 || !response.cookies.length) throw new Error('爱快登录失败，请检查账号密码');
        this.cookie = response.cookies.map(cookie => cookie.split(';')[0]).join('; ');
    }

    public async exec(module: string, action: string, params: Record<string, unknown>): Promise<any> {
        if (!this.cookie) throw new Error('尚未登录爱快');
        return (await this.request('/Action/call', {func_name: module, action, param: params})).body;
    }

    private request(endpoint: string, value: unknown): Promise<{body: any; cookies: string[]}> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(value);
            const req = http.request({hostname: this.host, port: this.port, method: 'POST', path: endpoint,
                headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                    ...(this.cookie ? {Cookie: this.cookie} : {})}}, response => {
                let data = '';
                response.setEncoding('utf8');
                response.on('data', chunk => {
                    data += chunk;
                    if (data.length > 2 * 1024 * 1024) req.destroy(new Error('爱快响应过大'));
                });
                response.once('error', fail);
                response.once('aborted', () => fail(new Error('爱快响应中断')));
                response.once('end', () => {
                    clearTimeout(timer);
                    try {
                        if (response.statusCode !== 200) throw new Error('爱快 HTTP 状态码：' + response.statusCode);
                        resolve({body: JSON.parse(data), cookies: response.headers['set-cookie'] || []});
                    } catch (error) { reject(new Error('爱快响应异常：' + String(error))); }
                });
            });
            const timer = setTimeout(() => req.destroy(new Error('爱快请求超时')), this.timeoutMs);
            const fail = (error: Error) => { clearTimeout(timer); reject(error); };
            req.once('error', fail);
            req.end(body);
        });
    }
}
