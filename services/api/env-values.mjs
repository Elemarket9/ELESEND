/** Reads a whole-number setting, falling back when it is missing or invalid. */
export const envInt=(value,fallback,min=1)=>{const n=Number(value);return value!==undefined&&value!==''&&Number.isSafeInteger(n)&&n>=min?n:fallback;};
