#!/usr/bin/env python3
"""Generate the wire-protocol sources from protocol.yaml (architecture.md).

Outputs (committed; never edit by hand):
    generated/relay_proto.h   packed big-endian structs + _Static_asserts,
                              for the Melee decomp and the Nintendont kernel
    generated/wire.ts         DataView encode/decode for the relay

The generator computes every struct layout with natural alignment and refuses
to emit anything if a field would need implicit padding (padding must be an
explicit _pad field) or if the computed size disagrees with the size declared
in protocol.yaml. So the YAML, the C header, and the TS codec cannot drift
from each other without this script failing.

Usage:
    python tools/gen_protocol.py [--out-dir generated]

Requires: PyYAML (pip install pyyaml).
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PROTOCOL_YAML = ROOT / "protocol.yaml"
DEFAULT_OUT_DIR = ROOT / "generated"

GENERATED_BANNER = "GENERATED from protocol.yaml by tools/gen_protocol.py -- DO NOT EDIT."

PRIMITIVES = {
    # name: (size, align, c type, DataView getter/setter suffix)
    "u8":  (1, 1, "uint8_t",  "Uint8"),
    "u16": (2, 2, "uint16_t", "Uint16"),
    "u32": (4, 4, "uint32_t", "Uint32"),
    "char": (1, 1, "char",    None),
}


class ProtocolError(Exception):
    pass


@dataclass
class Field:
    name: str
    type: str                    # primitive or struct name
    offset: int
    doc: str | None = None
    array_len: int | None = None       # fixed array element count
    array_const: str | None = None     # constant name used for the count, if any
    count_field: str | None = None     # variable array: name of the count field
    max_const: str | None = None       # variable array: cap constant
    is_struct: bool = False

    @property
    def is_pad(self) -> bool:
        return self.name.startswith("_pad")

    @property
    def is_variable(self) -> bool:
        return self.count_field is not None


@dataclass
class Struct:
    name: str
    doc: str
    declared_size: int
    fields: list[Field] = field(default_factory=list)
    size: int = 0                # fixed part only, for variable structs
    align: int = 1

    @property
    def variable_field(self) -> Field | None:
        last = self.fields[-1] if self.fields else None
        return last if last is not None and last.is_variable else None


@dataclass
class Protocol:
    version: int
    magic: str
    constants: dict[str, tuple[int, str | None]]
    enums: dict[str, tuple[str, dict[str, tuple[int, str | None]]]]
    structs: dict[str, Struct]
    messages: dict[str, tuple[str | None, str | None]]


# ---------------------------------------------------------------- loading

def load_protocol(path: Path) -> Protocol:
    spec = yaml.safe_load(path.read_text(encoding="utf-8"))

    proto = spec["protocol"]
    magic = proto["magic"]
    if len(magic) != 2 or not magic.isascii():
        raise ProtocolError(f"protocol.magic must be 2 ASCII bytes, got {magic!r}")
    if proto.get("endian", "big") != "big":
        raise ProtocolError("only big-endian is supported")
    version = int(proto["version"])
    if not 0 <= version <= 255:
        raise ProtocolError("protocol.version must fit in a u8")

    constants: dict[str, tuple[int, str | None]] = {}
    for name, c in spec.get("constants", {}).items():
        if isinstance(c, dict):
            constants[name] = (int(c["value"]), c.get("doc"))
        else:
            constants[name] = (int(c), None)

    enums: dict[str, tuple[str, dict[str, tuple[int, str | None]]]] = {}
    for ename, e in spec.get("enums", {}).items():
        values: dict[str, tuple[int, str | None]] = {}
        for vname, v in e["values"].items():
            val = int(v["value"]) if isinstance(v, dict) else int(v)
            if not 0 <= val <= 255:
                raise ProtocolError(f"{ename}.{vname} must fit in a u8 (wire fields are u8)")
            values[vname] = (val, v.get("doc") if isinstance(v, dict) else None)
        enums[ename] = (e.get("doc", ""), values)

    structs = _load_structs(spec.get("structs", {}), constants)

    messages: dict[str, tuple[str | None, str | None]] = {}
    cmd_values = {name for _, vals in enums.values() for name in vals} if enums else set()
    for cmd, m in spec.get("messages", {}).items():
        if cmd not in cmd_values:
            raise ProtocolError(f"messages: {cmd} is not an enum value")
        for key in ("request", "response_payload"):
            ref = m.get(key)
            if ref is not None and ref not in structs:
                raise ProtocolError(f"messages.{cmd}.{key}: unknown struct {ref}")
        messages[cmd] = (m.get("request"), m.get("response_payload"))

    return Protocol(version, magic, constants, enums, structs, messages)


def _load_structs(spec: dict, constants: dict[str, tuple[int, str | None]]) -> dict[str, Struct]:
    structs: dict[str, Struct] = {}
    for sname, s in spec.items():
        st = Struct(name=sname, doc=s.get("doc", ""), declared_size=int(s["size"]))
        offset = 0
        seen: dict[str, Field] = {}
        for i, f in enumerate(s["fields"]):
            fname, ftype = f["name"], f["type"]
            is_struct = ftype in structs
            if not is_struct and ftype not in PRIMITIVES:
                raise ProtocolError(f"{sname}.{fname}: unknown type {ftype!r} "
                                    "(structs must be defined before use)")
            if is_struct:
                elem_size, elem_align = structs[ftype].size, structs[ftype].align
                if structs[ftype].variable_field is not None:
                    raise ProtocolError(f"{sname}.{fname}: cannot nest variable-length struct")
            else:
                elem_size, elem_align = PRIMITIVES[ftype][0], PRIMITIVES[ftype][1]

            fld = Field(name=fname, type=ftype, offset=offset, doc=f.get("doc"),
                        is_struct=is_struct)

            arr = f.get("array")
            if arr is not None:
                if isinstance(arr, int):
                    fld.array_len = arr
                elif arr in constants:
                    fld.array_len, fld.array_const = constants[arr][0], arr
                elif arr in seen:
                    count = seen[arr]
                    if count.type not in ("u8", "u16", "u32") or count.array_len is not None:
                        raise ProtocolError(f"{sname}.{fname}: count field {arr} must be a "
                                            "scalar unsigned integer")
                    fld.count_field = arr
                    if "max" in f:
                        if f["max"] not in constants:
                            raise ProtocolError(f"{sname}.{fname}: max must name a constant")
                        fld.max_const = f["max"]
                    if i != len(s["fields"]) - 1:
                        raise ProtocolError(f"{sname}.{fname}: variable array must be last")
                else:
                    raise ProtocolError(f"{sname}.{fname}: array bound {arr!r} is neither an "
                                        "int, a constant, nor a prior field")
            elif ftype == "char":
                raise ProtocolError(f"{sname}.{fname}: char fields must be arrays")

            if offset % elem_align != 0:
                raise ProtocolError(f"{sname}.{fname}: offset {offset} breaks natural alignment "
                                    f"{elem_align}; add an explicit _pad field")
            if not fld.is_variable:
                offset += elem_size * (fld.array_len or 1)

            st.fields.append(fld)
            st.align = max(st.align, elem_align)
            seen[fname] = fld

        if offset % st.align != 0:
            raise ProtocolError(f"{sname}: size {offset} is not a multiple of alignment "
                                f"{st.align}; add trailing _pad")
        st.size = offset
        if st.size != st.declared_size:
            raise ProtocolError(f"{sname}: declared size {st.declared_size} but computed "
                                f"{st.size}")
        if st.variable_field is not None:
            vf = st.variable_field
            if vf.offset % structs[vf.type].align != 0:
                raise ProtocolError(f"{sname}.{vf.name}: variable array misaligned")
        structs[sname] = st
    return structs


# ---------------------------------------------------------------- helpers

def pascal(name: str) -> str:
    return "".join(p.capitalize() for p in name.split("_"))


def c_type(f: Field) -> str:
    return f"struct {f.type}" if f.is_struct else PRIMITIVES[f.type][2]


def ts_get(ftype: str, offset_expr: str) -> str:
    # getUint8 takes no endianness argument; the wider getters need big-endian.
    endian = "" if PRIMITIVES[ftype][0] == 1 else ", false"
    return f"dv.get{PRIMITIVES[ftype][3]}({offset_expr}{endian})"


def ts_set(ftype: str, offset_expr: str, value_expr: str) -> str:
    endian = "" if PRIMITIVES[ftype][0] == 1 else ", false"
    return f"dv.set{PRIMITIVES[ftype][3]}({offset_expr}, {value_expr}{endian})"


def c_array_suffix(f: Field) -> str:
    if f.is_variable:
        return "[]"
    if f.array_len is None:
        return ""
    return f"[{f.array_const or f.array_len}]"


# ---------------------------------------------------------------- C header

def emit_c(p: Protocol) -> str:
    out: list[str] = []
    w = out.append
    w(f"/* relay_proto.h -- {GENERATED_BANNER}")
    w(" *")
    w(" * Wire protocol between the Wii (Melee decomp / Nintendont kernel) and the")
    w(" * relay on the Pi. See docs/architecture.md.")
    w(" *")
    w(" * All integers big-endian on the wire; PowerPC is big-endian, so these")
    w(" * structs are sent and received as-is with zero byte-swapping.")
    w(" * All strings ASCII, NUL-padded, not NUL-terminated if full.")
    w(" */")
    w("#ifndef RELAY_PROTO_H")
    w("#define RELAY_PROTO_H")
    w("")
    w("#include <stddef.h>")
    w("")
    w("/* The melee decomp's MWCC/MSL toolchain ships no <stdint.h>. Its EABI")
    w(" * types match these widths exactly; no other TU in that tree defines")
    w(" * the uintN_t names. Every other consumer (Nintendont's ARM GCC) has")
    w(" * the real header. */")
    w("#ifdef __MWERKS__")
    w("typedef unsigned char uint8_t;")
    w("typedef unsigned short uint16_t;")
    w("typedef unsigned long uint32_t;")
    w("#else")
    w("#include <stdint.h>")
    w("#endif")
    w("")
    w("/* Layout guards. C11 gives us _Static_assert; the pre-C11 fallback (the")
    w(" * decomp's MWCC toolchain) diagnoses via a negative array size instead. */")
    w("#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)")
    w("#define RELAY_STATIC_ASSERT(cond, tag) _Static_assert((cond), #tag)")
    w("#else")
    w("#define RELAY_STATIC_ASSERT(cond, tag) \\")
    w("    typedef char relay_static_assert_##tag[(cond) ? 1 : -1]")
    w("#endif")
    w("")
    w(f"#define RELAY_PROTO_VERSION {p.version}")
    w(f"#define RELAY_MAGIC_0 '{p.magic[0]}'")
    w(f"#define RELAY_MAGIC_1 '{p.magic[1]}'")
    w("")
    name_w = max(len(n) for n in p.constants)
    for name, (value, doc) in p.constants.items():
        comment = f"  /* {doc} */" if doc else ""
        cval = f"0x{value:X}" if value > 0x7FFFFFFF else str(value)
        w(f"#define {name:<{name_w}} {cval}{comment}")

    for ename, (doc, values) in p.enums.items():
        w("")
        if doc:
            w(f"/* {doc} */")
        w(f"enum {ename} {{")
        vw = max(len(v) for v in values)
        for vname, (value, vdoc) in values.items():
            comment = f"  /* {vdoc} */" if vdoc else ""
            w(f"    {vname:<{vw}} = {value},{comment}")
        w("};")

    for st in p.structs.values():
        w("")
        if st.doc:
            for line in _wrap_comment(st.doc):
                w(line)
        w(f"struct {st.name} {{")
        tw = max(len(c_type(f)) for f in st.fields)
        for f in st.fields:
            decl = f"{c_type(f):<{tw}} {f.name}{c_array_suffix(f)};"
            comment = f"  /* {f.doc} */" if f.doc else ""
            w(f"    {decl}{comment}")
        variable = st.variable_field is not None
        w(f"}};  /* {st.size} bytes{' + variable tail' if variable else ''} */")
        w("")
        w(f"RELAY_STATIC_ASSERT(sizeof(struct {st.name}) == {st.size}, {st.name}_size);")
        for f in st.fields:
            w(f"RELAY_STATIC_ASSERT(offsetof(struct {st.name}, {f.name}) == {f.offset}, "
              f"{st.name}_{f.name});")

    w("")
    w("/* Message map: payload struct after relay_hdr (request) and after")
    w(" * relay_resp (ST_OK response)." )
    w(" *")
    cw = max(len(c) for c in p.messages)
    for cmd, (req, resp) in p.messages.items():
        w(f" *   {cmd:<{cw}}  req: {req or '-':<18} resp payload: {resp or '-'}")
    w(" */")
    w("")
    w("#endif /* RELAY_PROTO_H */")
    return "\n".join(out) + "\n"


def _wrap_comment(doc: str, width: int = 76) -> list[str]:
    import textwrap
    lines = textwrap.wrap(doc, width)
    if len(lines) == 1:
        return [f"/* {lines[0]} */"]
    return ["/* " + lines[0]] + [" * " + l for l in lines[1:]] + [" */"]


# ---------------------------------------------------------------- wire.ts

def emit_ts(p: Protocol) -> str:
    out: list[str] = []
    w = out.append
    w(f"// wire.ts -- {GENERATED_BANNER}")
    w("//")
    w("// Struct encode/decode for the Wii <-> relay protocol (architecture.md).")
    w("// All integers big-endian. Strings are ASCII, NUL-padded, not NUL-terminated")
    w("// if full; encode silently truncates over-long strings and replaces")
    w("// non-printable-ASCII characters with '?'. _pad and variable-array count")
    w("// fields are wire artifacts and do not appear on the interfaces.")
    w("")
    w(f"export const PROTO_VERSION = {p.version};")
    w(f"export const MAGIC_0 = 0x{ord(p.magic[0]):02x}; // '{p.magic[0]}'")
    w(f"export const MAGIC_1 = 0x{ord(p.magic[1]):02x}; // '{p.magic[1]}'")
    w("")
    for name, (value, doc) in p.constants.items():
        comment = f" // {doc}" if doc else ""
        w(f"export const {name} = {value};{comment}")

    for ename, (doc, values) in p.enums.items():
        w("")
        if doc:
            w(f"/** {doc} */")
        w(f"export enum {pascal(ename)} {{")
        for vname, (value, vdoc) in values.items():
            comment = f" // {vdoc}" if vdoc else ""
            w(f"  {vname} = {value},{comment}")
        w("}")

    w("")
    w("// ---- ASCII field helpers ----")
    w("")
    w("function putAscii(bytes: Uint8Array, off: number, len: number, s: string): void {")
    w("  for (let i = 0; i < len; i++) {")
    w("    let c = i < s.length ? s.charCodeAt(i) : 0;")
    w("    if (c !== 0 && (c < 0x20 || c > 0x7e)) c = 0x3f; // '?'")
    w("    bytes[off + i] = c;")
    w("  }")
    w("}")
    w("")
    w("function getAscii(bytes: Uint8Array, off: number, len: number): string {")
    w("  let end = off;")
    w("  while (end < off + len && bytes[end] !== 0) end++;")
    w("  let s = '';")
    w("  for (let i = off; i < end; i++) s += String.fromCharCode(bytes[i]);")
    w("  return s;")
    w("}")
    w("")
    w("function checkLen(buf: Uint8Array, off: number, need: number, what: string): void {")
    w("  if (off < 0 || off + need > buf.length) {")
    w("    throw new RangeError(")
    w("      `${what}: need ${need} bytes at offset ${off}, have ${buf.length}`,")
    w("    );")
    w("  }")
    w("}")

    for st in p.structs.values():
        w("")
        w(f"// ---- {st.name} ({st.size} bytes"
          + (" + variable tail" if st.variable_field else "") + ") ----")
        w("")
        _ts_interface(w, st)
        _ts_encode(w, st, p)
        _ts_decode(w, st, p)

    w("")
    w("// ---- message map (architecture.md): request struct after relay_hdr,")
    w("// ---- payload struct after relay_resp in an ST_OK response ----")
    w("")
    cmd_enum = _cmd_enum_name(p)
    w("export const REQUEST_DECODERS = {")
    for cmd, (req, _) in p.messages.items():
        if req is not None:
            w(f"  [{cmd_enum}.{cmd}]: decode{pascal(req)},")
    w("} as const;")
    w("")
    w("export const RESPONSE_PAYLOAD_DECODERS = {")
    for cmd, (_, resp) in p.messages.items():
        if resp is not None:
            w(f"  [{cmd_enum}.{cmd}]: decode{pascal(resp)},")
    w("} as const;")
    return "\n".join(out) + "\n"


def _cmd_enum_name(p: Protocol) -> str:
    for ename, (_, values) in p.enums.items():
        if any(v in p.messages for v in values):
            return pascal(ename)
    raise ProtocolError("no enum contains the message commands")


def _is_count_field(st: Struct, f: Field) -> bool:
    vf = st.variable_field
    return vf is not None and vf.count_field == f.name


def _ts_field_type(f: Field) -> str:
    if f.is_struct:
        return f"{pascal(f.type)}[]" if (f.is_variable or f.array_len is not None) else pascal(f.type)
    if f.type == "char":
        return "string"
    if f.array_len is not None:
        # Byte arrays stay Uint8Array (magic fields, tests pass them as such);
        # arrays of wider integers are plain number[] in natural units.
        return "Uint8Array" if PRIMITIVES[f.type][0] == 1 else "number[]"
    return "number"


def _ts_interface(w, st: Struct) -> None:
    if st.doc:
        w(f"/** {st.doc} */")
    w(f"export interface {pascal(st.name)} {{")
    for f in st.fields:
        if f.is_pad or _is_count_field(st, f):
            continue
        comment = f" // {f.doc}" if f.doc else ""
        w(f"  {f.name}: {_ts_field_type(f)};{comment}")
    w("}")
    w(f"export const {st.name.upper()}_SIZE = {st.size};"
      + (f" // fixed part; {st.variable_field.name}[] follows" if st.variable_field else ""))
    w("")


def _ts_encode(w, st: Struct, p: Protocol) -> None:
    name = pascal(st.name)
    vf = st.variable_field
    w(f"export function encode{name}(v: {name}): Uint8Array {{")
    if vf is not None:
        elem = p.structs[vf.type]
        if vf.max_const is not None:
            w(f"  if (v.{vf.name}.length > {vf.max_const}) {{")
            w(f"    throw new RangeError(`{st.name}.{vf.name}: ${{v.{vf.name}.length}} "
              f"entries, max ` + {vf.max_const});")
            w("  }")
        w(f"  const bytes = new Uint8Array({st.name.upper()}_SIZE + "
          f"v.{vf.name}.length * {elem.name.upper()}_SIZE);")
    else:
        w(f"  const bytes = new Uint8Array({st.name.upper()}_SIZE);")
    w("  const dv = new DataView(bytes.buffer);")
    for f in st.fields:
        if f.is_pad:
            continue  # buffer starts zeroed
        if _is_count_field(st, f):
            w(f"  {ts_set(f.type, str(f.offset), f'v.{vf.name}.length')};")
        elif f.is_variable:
            elem = p.structs[f.type]
            w(f"  for (let i = 0; i < v.{f.name}.length; i++) {{")
            w(f"    bytes.set(encode{pascal(f.type)}(v.{f.name}[i]), "
              f"{f.offset} + i * {elem.name.upper()}_SIZE);")
            w("  }")
        elif f.is_struct and f.array_len is None:
            w(f"  bytes.set(encode{pascal(f.type)}(v.{f.name}), {f.offset});")
        elif f.is_struct:
            elem = p.structs[f.type]
            w(f"  if (v.{f.name}.length > {f.array_const or f.array_len}) {{")
            w(f"    throw new RangeError(`{st.name}.{f.name}: ${{v.{f.name}.length}} entries, "
              f"max ` + {f.array_const or f.array_len});")
            w("  }")
            w(f"  for (let i = 0; i < v.{f.name}.length; i++) {{")
            w(f"    bytes.set(encode{pascal(f.type)}(v.{f.name}[i]), "
              f"{f.offset} + i * {elem.name.upper()}_SIZE);")
            w("  }")
        elif f.type == "char":
            w(f"  putAscii(bytes, {f.offset}, {f.array_const or f.array_len}, v.{f.name});")
        elif f.array_len is not None and PRIMITIVES[f.type][0] == 1:  # u8 byte array
            w(f"  bytes.set(v.{f.name}.subarray(0, {f.array_const or f.array_len}), {f.offset});")
        elif f.array_len is not None:  # wide integer array, big-endian per element
            size = PRIMITIVES[f.type][0]
            w(f"  if (v.{f.name}.length > {f.array_const or f.array_len}) {{")
            w(f"    throw new RangeError(`{st.name}.{f.name}: ${{v.{f.name}.length}} entries, "
              f"max ` + {f.array_const or f.array_len});")
            w("  }")
            w(f"  for (let i = 0; i < v.{f.name}.length; i++) {{")
            w(f"    {ts_set(f.type, f'{f.offset} + i * {size}', f'v.{f.name}[i]!')};")
            w("  }")
        else:
            w(f"  {ts_set(f.type, str(f.offset), f'v.{f.name}')};")
    w("  return bytes;")
    w("}")
    w("")


def _ts_decode(w, st: Struct, p: Protocol) -> None:
    name = pascal(st.name)
    vf = st.variable_field
    w(f"export function decode{name}(buf: Uint8Array, off = 0): {name} {{")
    w(f"  checkLen(buf, off, {st.name.upper()}_SIZE, '{st.name}');")
    w("  const dv = new DataView(buf.buffer, buf.byteOffset);")
    lines: list[str] = []
    for f in st.fields:
        if f.is_pad:
            continue
        if _is_count_field(st, f):
            continue
        if f.is_variable:
            continue
        if f.is_struct and f.array_len is None:
            lines.append(f"    {f.name}: decode{pascal(f.type)}(buf, off + {f.offset}),")
        elif f.is_struct:
            elem = p.structs[f.type]
            lines.append(f"    {f.name}: Array.from({{ length: {f.array_const or f.array_len} }}, "
                         f"(_, i) => decode{pascal(f.type)}(buf, off + {f.offset} + "
                         f"i * {elem.name.upper()}_SIZE)),")
        elif f.type == "char":
            lines.append(f"    {f.name}: getAscii(buf, off + {f.offset}, "
                         f"{f.array_const or f.array_len}),")
        elif f.array_len is not None and PRIMITIVES[f.type][0] == 1:
            lines.append(f"    {f.name}: buf.slice(off + {f.offset}, off + {f.offset} + "
                         f"{f.array_const or f.array_len}),")
        elif f.array_len is not None:
            size = PRIMITIVES[f.type][0]
            lines.append(f"    {f.name}: Array.from({{ length: {f.array_const or f.array_len} }}, "
                         f"(_, i) => {ts_get(f.type, f'off + {f.offset} + i * {size}')}),")
        else:
            lines.append(f"    {f.name}: {ts_get(f.type, f'off + {f.offset}')},")
    if vf is not None:
        count = next(f for f in st.fields if f.name == vf.count_field)
        elem = p.structs[vf.type]
        w(f"  const count = {ts_get(count.type, f'off + {count.offset}')};")
        if vf.max_const is not None:
            w(f"  if (count > {vf.max_const}) {{")
            w(f"    throw new RangeError(`{st.name}.{count.name}: ${{count}} entries, max ` + "
              f"{vf.max_const});")
            w("  }")
        w(f"  checkLen(buf, off, {st.name.upper()}_SIZE + count * {elem.name.upper()}_SIZE, "
          f"'{st.name}');")
        lines.append(f"    {vf.name}: Array.from({{ length: count }}, "
                     f"(_, i) => decode{pascal(vf.type)}(buf, off + {vf.offset} + "
                     f"i * {elem.name.upper()}_SIZE)),")
    w("  return {")
    for line in lines:
        w(line)
    w("  };")
    w("}")
    w("")


# ---------------------------------------------------------------- main

def generate(out_dir: Path) -> dict[Path, str]:
    p = load_protocol(PROTOCOL_YAML)
    return {
        out_dir / "relay_proto.h": emit_c(p),
        out_dir / "wire.ts": emit_ts(p),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = ap.parse_args()

    try:
        files = generate(args.out_dir)
    except ProtocolError as e:
        print(f"protocol.yaml: {e}", file=sys.stderr)
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for path, content in files.items():
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        print(f"wrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
