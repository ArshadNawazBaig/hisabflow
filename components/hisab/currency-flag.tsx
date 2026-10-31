import PK from 'country-flag-icons/react/3x2/PK';
import US from 'country-flag-icons/react/3x2/US';
import AE from 'country-flag-icons/react/3x2/AE';
import GB from 'country-flag-icons/react/3x2/GB';
import EU from 'country-flag-icons/react/3x2/EU';

const flags = new Map([
  ['PKR', PK],
  ['USD', US],
  ['AED', AE],
  ['GBP', GB],
  ['EUR', EU],
]);

export function CurrencyFlag({ currency }: { currency: string }) {
  const Flag = flags.get(currency.trim().toUpperCase());
  return Flag ? <Flag className="currency-flag" aria-hidden="true" tabIndex={-1}/> : null;
}
