import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { DevelopmentController } from './development.controller';
import { EmployeesController } from './employees.controller';
import { FinanceBridge } from './finance.bridge';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { MeController } from './me.controller';
import { OvertimeController } from './overtime.controller';
import { OvertimeService } from './overtime.service';
import { PayrollController, PayslipsController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { RosterController } from './roster.controller';
import { WorkforceService } from './workforce.service';

/**
 * Workforce 360: employee directory and profile (core Employee), staff attendance (biometric webhook, app, manual),
 * shifts and rosters, leave, overtime, workload, CPD, payroll runs and payslips, and staff self-service (/me).
 */
@Module({
  controllers: [
    EmployeesController,
    AttendanceController,
    RosterController,
    LeaveController,
    OvertimeController,
    DevelopmentController,
    PayrollController,
    PayslipsController,
    MeController,
  ],
  providers: [WorkforceService, FinanceBridge, LeaveService, OvertimeService, PayrollService],
  exports: [WorkforceService],
})
export class WorkforceModule {}
