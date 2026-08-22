// Vendored TokenTracker dashboard 入口。provider 顺序固定（TokenFormatProvider
// 依赖 LocaleProvider 的 resolvedLocale），不要随意调整。
// 样式（Tailwind v4 编译产物 + .tt-dashboard 作用域变量）集中在此引入，
// 保证该功能移除时样式随之移除。
import '../../styles/tokentracker-dashboard.css';
import { DashboardPage } from './tokentracker-dashboard/pages/DashboardPage.jsx';
import { CurrencyProvider } from './tokentracker-dashboard/ui/foundation/CurrencyProvider.jsx';
import { LocaleProvider } from './tokentracker-dashboard/ui/foundation/LocaleProvider.jsx';
import { ThemeProvider } from './tokentracker-dashboard/ui/foundation/ThemeProvider.jsx';
import { TokenFormatProvider } from './tokentracker-dashboard/ui/foundation/TokenFormatProvider.jsx';

// DashboardPage 是无类型 .jsx：tsc 从解构参数推断出必选 props，但 desktop 侧
// 的 .d.ts 声明它们全部可选（baseUrl 走 transport 路由，无需传入）。这里与
// desktop 一致——不传任何 props。
const DashboardPageView = DashboardPage as React.ComponentType;

export default function TokenTrackerDashboardView() {
  return (
    <div className="tt-dashboard">
      <LocaleProvider>
        <CurrencyProvider>
          <TokenFormatProvider>
            <ThemeProvider>
              <DashboardPageView />
            </ThemeProvider>
          </TokenFormatProvider>
        </CurrencyProvider>
      </LocaleProvider>
    </div>
  );
}
