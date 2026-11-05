import PK from 'country-flag-icons/react/3x2/PK';
import US from 'country-flag-icons/react/3x2/US';
import AE from 'country-flag-icons/react/3x2/AE';
import GB from 'country-flag-icons/react/3x2/GB';
import EU from 'country-flag-icons/react/3x2/EU';

export function CurrencyFlag({ currency }: { currency: string }) {
  const props={className:'currency-flag','aria-hidden':true as const,tabIndex:-1};
  switch(currency.trim().toUpperCase()) {
    case 'PKR': return <PK {...props}/>;
    case 'USD': return <US {...props}/>;
    case 'AED': return <AE {...props}/>;
    case 'GBP': return <GB {...props}/>;
    case 'EUR': return <EU {...props}/>;
    default: return null;
  }
}
