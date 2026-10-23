import fs from 'fs';
import csv from 'csv-parser';
import {isIP} from 'net';

export class FileUtils {
    public static loadDomainList(filePath: string): string[] {
        return Array.from(new Set(fs.readFileSync(filePath, 'utf8').split('\n')
            .map(line => line.split('#')[0].trim()).filter(Boolean)));
    }

    public static readCsv2IpArray(filepath: string, max: number, family?: 4 | 6): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const results = new Map<string, number>();
            const source = fs.createReadStream(filepath);
            const parser = csv();
            const fail = (error: Error) => { source.destroy(); parser.destroy(); reject(error); };
            source.on('error', fail);
            parser.on('error', fail);
            source.pipe(parser).on('data', row => {
                const ip = String(row['IP 地址'] || '').trim();
                const latency = Number(row['平均延迟']);
                const loss = Number(row['丢包率']);
                if (isIP(ip) && (!family || isIP(ip) === family) && row['平均延迟'] !== ''
                    && Number.isFinite(latency) && latency >= 0 && Number.isFinite(loss) && loss >= 0 && loss <= 1) {
                    results.set(ip, Math.min(latency, results.get(ip) ?? Infinity));
                }
            }).on('end', () => resolve(Array.from(results).sort((a,b) => a[1]-b[1]).slice(0, max).map(([ip]) => ip)));
        });
    }

    public static writeJson(file: string, value: unknown): void {
        const temporary = file + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
        fs.renameSync(temporary, file);
    }
}
