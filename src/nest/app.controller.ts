import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): { message: string; framework: string; timestamp: string } {
    return this.appService.getHello();
  }

  @Get('/status')
  getStatus() {
    return this.appService.getStatus();
  }
}

