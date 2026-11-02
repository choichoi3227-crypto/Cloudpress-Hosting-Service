import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AppService } from './app.service';

@Controller('ai')
export class AiCompanyController {
  constructor(private readonly appService: AppService) {}

  @Get('overview')
  getOverview() {
    return {
      message: 'AI Company Overview API',
      employees: [
        { id: 'ai-001', name: 'Strategy Director', task: 'Market analysis', duration: '2h 15m', diligence: 92, mood: 'focused' },
        { id: 'ai-002', name: 'Engineering Lead', task: 'Container optimization', duration: '4h 30m', diligence: 88, mood: 'productive' },
        { id: 'ai-003', name: 'Customer Support Bot', task: 'Handling 12 tickets', duration: '1h 45m', diligence: 95, mood: 'engaged' },
      ],
      pixelGameView: 'ENABLED',
      queriesHandled: 2847,
      satisfaction: 91.4,
    };
  }

  @Post('provision')
  provision(@Body() body: any) {
    return {
      status: 'provisioning_started',
      resources: body.resources || [],
      timestamp: new Date().toISOString(),
      perfectProvisioning: true,
    };
  }

  @Post('hire/:employeeId/fire')
  fireEmployee(@Param('employeeId') employeeId: string) {
    return {
      action: 'fire',
      employeeId,
      status: 'terminated',
      replacementQueued: true,
    };
  }

  @Post('hire')
  hireEmployee(@Body() body: any) {
    return {
      action: 'hire',
      employeeId: `ai-${Date.now()}`,
      role: body.role,
      status: 'recruited',
    };
  }

  @Get('pixel-view')
  getPixelView() {
    return {
      grid: [
        { x: 10, y: 20, employee: 'ai-001', task: 'analysis', progress: 0.75 },
        { x: 50, y: 30, employee: 'ai-002', task: 'coding', progress: 0.42 },
        { x: 80, y: 60, employee: 'ai-003', task: 'support', progress: 0.91 },
      ],
      hoverDetails: 'ENABLED',
    };
  }
}
