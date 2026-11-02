import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): { message: string; framework: string; timestamp: string } {
    return {
      message: 'CloudPress Nest.js Backend Service active',
      framework: 'Nest.js + Astro Hybrid Architecture',
      timestamp: new Date().toISOString(),
    };
  }

  getStatus() {
    return {
      status: 'healthy',
      service: 'CloudPress Hosting Service',
      architecture: 'Astro (Frontend) + Nest.js (Backend API / Services) + Cloudflare Workers (Edge)',
    };
  }
}

