import { BlockList, isIP } from 'node:net';

// Rangos IPv4 que no son unicast público (RFC 6890 y relacionados)
const NON_PUBLIC_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "esta red"
  ['10.0.0.0', 8], // privada
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (metadatos de nube)
  ['172.16.0.0', 12], // privada
  ['192.0.0.0', 24], // asignaciones del IETF
  ['192.0.2.0', 24], // documentación
  ['192.88.99.0', 24], // relay 6to4
  ['192.168.0.0', 16], // privada
  ['198.18.0.0', 15], // pruebas de rendimiento
  ['198.51.100.0', 24], // documentación
  ['203.0.113.0', 24], // documentación
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservada y broadcast
];

// En IPv6 solo se admite unicast global (2000::/3), sin los rangos especiales que contiene
const NON_PUBLIC_IPV6_IN_GLOBAL: Array<[string, number]> = [
  ['2001::', 23], // asignaciones del IETF (Teredo incluido)
  ['2001:db8::', 32], // documentación
  ['2002::', 16], // 6to4: puede encapsular IPv4 privadas
];

const nonPublicIpv4 = blockListOf(NON_PUBLIC_IPV4, 'ipv4');
const nonPublicIpv6 = blockListOf(NON_PUBLIC_IPV6_IN_GLOBAL, 'ipv6');
const globalUnicastIpv6 = blockListOf([['2000::', 3]], 'ipv6');

const MAPPED_IPV4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !nonPublicIpv4.check(ip, 'ipv4');
  if (family !== 6) return false;

  const normalized = normalizeIpv6(ip);
  const mapped = toMappedIpv4(normalized);
  if (mapped) return isPublicIp(mapped);
  return globalUnicastIpv6.check(normalized, 'ipv6') && !nonPublicIpv6.check(normalized, 'ipv6');
}

// El parser de URL serializa IPv6 en forma canónica: minúsculas, comprimida y con la parte
// IPv4 de las direcciones mapeadas en hexadecimal (::ffff:7f00:1)
function normalizeIpv6(ip: string): string {
  return new URL(`http://[${ip}]`).hostname.slice(1, -1);
}

function toMappedIpv4(normalizedIpv6: string): string | null {
  const match = MAPPED_IPV4.exec(normalizedIpv6);
  if (!match) return null;
  const high = Number.parseInt(match[1] ?? '0', 16);
  const low = Number.parseInt(match[2] ?? '0', 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function blockListOf(subnets: Array<[string, number]>, type: 'ipv4' | 'ipv6'): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, type);
  return list;
}
