import { Module } from '@nestjs/common';
import { HealthzController } from './healthz.controller';

// Ни импортов, ни провайдеров: эндпоинт живости не должен зависеть ни
// от чего, иначе он перестанет отвечать ровно тогда, когда нужнее
// всего — при сломанной зависимости.
@Module({
  controllers: [HealthzController],
})
export class HealthzModule {}
