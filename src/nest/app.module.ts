import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiCompanyController } from './ai-company.controller';

@Module({
  imports: [],
  controllers: [AppController, AiCompanyController],
  providers: [AppService],
})
export class AppModule {}
