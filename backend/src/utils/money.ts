/**
 * Exact monetary arithmetic utilities in integer paise.
 * ₹1 = 100 paise.
 * Never use JavaScript Number floating point for financial calculations!
 */

export class MoneyUtil {
  /**
   * Parse a paise string into a BigInt safely.
   */
  static parsePaise(paiseStr: string | number | bigint | null | undefined): bigint {
    if (paiseStr === null || paiseStr === undefined) {
      return 0n;
    }
    if (typeof paiseStr === 'bigint') {
      return paiseStr;
    }
    if (typeof paiseStr === 'number') {
      if (!Number.isInteger(paiseStr)) {
        throw new Error(`Floating point money amount not permitted: ${paiseStr}`);
      }
      return BigInt(paiseStr);
    }
    const trimmed = paiseStr.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`Invalid integer paise string format: "${paiseStr}"`);
    }
    return BigInt(trimmed);
  }

  /**
   * Format BigInt paise as string for the API wire representation.
   */
  static toWireString(paise: bigint | number | string | null | undefined): string {
    if (paise === null || paise === undefined) {
      return '0';
    }
    return paise.toString();
  }

  /**
   * Convert Rupees string (e.g. "1200.50") to integer paise BigInt (e.g. 120050n).
   * Exact integer math without float precision drift.
   */
  static rupeesToPaise(rupeesInput: string | number): bigint {
    const str = rupeesInput.toString().trim();
    const isNegative = str.startsWith('-');
    const cleanStr = isNegative ? str.slice(1) : str;

    const parts = cleanStr.split('.');
    if (parts.length > 2) {
      throw new Error(`Invalid rupee decimal format: "${rupeesInput}"`);
    }

    const wholePart = parts[0] || '0';
    let fractionPart = parts[1] || '00';

    if (fractionPart.length === 1) {
      fractionPart += '0';
    } else if (fractionPart.length > 2) {
      // Truncate/round to 2 decimal places
      fractionPart = fractionPart.slice(0, 2);
    }

    const wholeBig = BigInt(wholePart);
    const fractionBig = BigInt(fractionPart);
    const totalPaise = wholeBig * 100n + fractionBig;

    return isNegative ? -totalPaise : totalPaise;
  }

  /**
   * Format paise to display Rupee string (e.g. 4800000n -> "₹48,000.00").
   */
  static formatINR(paise: bigint | number | string): string {
    const b = typeof paise === 'bigint' ? paise : BigInt(paise.toString());
    const isNegative = b < 0n;
    const abs = isNegative ? -b : b;
    const rupees = abs / 100n;
    const cents = abs % 100n;
    const centsStr = cents < 10n ? `0${cents}` : cents.toString();
    
    // Format Indian numbering format (lakhs, crores: 12,34,567.89)
    const rupeesStr = rupees.toString();
    let formattedRupees = '';
    if (rupeesStr.length <= 3) {
      formattedRupees = rupeesStr;
    } else {
      const lastThree = rupeesStr.slice(-3);
      const otherNumbers = rupeesStr.slice(0, -3);
      const withCommas = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
      formattedRupees = `${withCommas},${lastThree}`;
    }

    return `${isNegative ? '-' : ''}₹${formattedRupees}.${centsStr}`;
  }
}
