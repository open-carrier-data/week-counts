// The privacy scan of OCD's report path (tools/observed_reports.py in the data
// repository, which ports the app's PrivacyScan). Same patterns, same order.
// A hit names the rule, never the matched text.

const BLOCK_PATTERNS = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  long_decimal_identity: /\b\d{14,20}\b/,
  international_phone: /\+\d{8,15}\b/,
  secret_word: /\b(pswd|secret|token|authorization)\b/i,
  raw_vendor_file: /\b(customer\.xml|cscfeature\.xml|imsupdate\.json|omc\.info|customer_carrier_feature\.json|carrier_canonical_id_list\.json|carrier\.plist|\.ipcc|carrier_settings\.pb|mbn)\b/i,
  raw_vendor_key: /\b(CarrierFeature_|GRASSE-AUTH|SemCarrierFeature|CarrierBundle|CSettingsDir)\b/,
  gras_payload: /\b(updateURL|pkgHash|pkgSize|fileDownloadUrl|deviceId|imei)\b/i,
  ims_patch: /\b(imsswitch_update|imsprofile_update|globalsettings_update|mnomap_update|add_mnomap|remove_mnomap|remove_profile|epdgsettings|iwlansettings|vowifisettings|enableIms|enableService[A-Za-z]+|mnoname)\b/,
  sip_or_tel_uri: /\b(?:sip|sips|tel|urn):[^\s,;>"\]]+/,
  ipv4_address: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  ipv6_address: /\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){3,7}\b/,
};
const PHONE_PATTERNS = {
  spaced_international_phone: /\+\d{1,3}[ ./-]?(?:\(\d{1,5}\)[ ./-]?)?\d{2,5}[ ./-]\d{3,}/,
  national_phone: /\b0\d{2,5}[ /-]?\d{6,}\b/,
};
const BLOCKED_KEY = /(imsi|iccid|imei|meid|msisdn|phone_number|subscriber|line1|device_id|android_id|serial)/i;

/** The rules `text` breaks. `fixedShape`: an ID whose all-digit parts can look like a national number. */
export function scanText(text, fixedShape = false) {
  const rules = { ...BLOCK_PATTERNS, ...(fixedShape ? {} : PHONE_PATTERNS) };
  return Object.keys(rules).filter((name) => rules[name].test(text));
}

/** Every rule any key or string under `value` breaks. Carrier IDs are the fixed-shape fields. */
export function scanValue(value, key = "") {
  if (Array.isArray(value)) return value.flatMap((item) => scanValue(item, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([name, child]) => [
      ...(BLOCKED_KEY.test(name) ? ["blocked_key"] : []),
      ...scanValue(child, name),
    ]);
  }
  return typeof value === "string" ? scanText(value, key === "carrier") : [];
}
