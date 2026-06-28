import { Controller, Post, Body, Param, Headers, BadRequestException } from '@nestjs/common';
import { CheckoutsService } from './checkouts.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

@Controller('checkouts')
export class CheckoutsController {
  constructor(private readonly checkoutsService: CheckoutsService) {}

  @Post()
  createCheckout(
    @Body() createCheckoutDto: CreateCheckoutDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('idempotency-key header is required');
    }
    return this.checkoutsService.createCheckout(createCheckoutDto, idempotencyKey);
  }

  @Post(':id/payment/success')
  markPaymentSuccess(@Param('id') id: string) {
    return this.checkoutsService.markPaymentSuccess(id);
  }

  @Post(':id/payment/failed')
  markPaymentFailed(@Param('id') id: string) {
    return this.checkoutsService.markPaymentFailed(id);
  }

  @Post(':id/payment/abandoned')
  markPaymentAbandoned(@Param('id') id: string) {
    return this.checkoutsService.markPaymentAbandoned(id);
  }

  @Post('expire')
  sweepExpiredCheckouts() {
    return this.checkoutsService.sweepExpiredCheckouts().then(count => ({
      message: `Expired ${count} abandoned checkouts`,
      expiredCount: count
    }));
  }
}
