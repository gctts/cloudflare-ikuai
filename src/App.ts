import {Logger} from 'winston';
import {ServiceConfigs} from './configs/ServiceConfigs';
import {IkuaiService} from './services/IkuaiService';
const cron = require('node-cron');

export function exclusiveTask(task: () => Promise<void>, logger: Pick<Logger, 'warn' | 'error'>): () => Promise<void> {
    let running = false;
    return async () => {
        if (running) { logger.warn('上一轮测速尚未结束，跳过本次调度'); return; }
        running = true;
        try { await task(); }
        catch (error) { logger.error('本轮任务失败：' + String(error)); }
        finally { running = false; }
    };
}

export class App {
    constructor(private logger: Logger, private configs: ServiceConfigs) {}
    public main(): void {
        if (!cron.validate(this.configs.CRON)) throw new Error('无效 CRON：' + this.configs.CRON);
        const service = new IkuaiService(this.configs, this.logger);
        const run = exclusiveTask(() => service.task(), this.logger);
        void run();
        cron.schedule(this.configs.CRON, () => { void run(); }, {timezone: this.configs.TZ});
        this.logger.info('调度已启动：' + this.configs.CRON);
    }
}
