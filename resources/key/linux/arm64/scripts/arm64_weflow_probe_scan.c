#include <elf.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const unsigned char ANCHOR[] = "com.Tencent.WCDB.Config.Cipher";

static int64_t sign_extend(uint64_t value, int bits) {
  uint64_t sign = 1ULL << (bits - 1);
  return (int64_t)((value ^ sign) - sign);
}

static int decode_adrp(uint32_t insn, uint64_t pc, int *rd, uint64_t *page) {
  if ((insn & 0x9f000000u) != 0x90000000u) return 0;
  uint64_t immlo = (insn >> 29) & 0x3u;
  uint64_t immhi = (insn >> 5) & 0x7ffffu;
  int64_t imm = sign_extend((immhi << 2) | immlo, 21) << 12;
  *rd = (int)(insn & 0x1fu);
  *page = (pc & ~0xfffULL) + imm;
  return 1;
}

static int decode_add_imm(uint32_t insn, int *rd, int *rn, uint64_t *imm) {
  if ((insn & 0xff000000u) != 0x91000000u) return 0;
  uint32_t shift = (insn >> 22) & 0x3u;
  if (shift > 1) return 0;
  *rd = (int)(insn & 0x1fu);
  *rn = (int)((insn >> 5) & 0x1fu);
  *imm = (uint64_t)((insn >> 10) & 0xfffu) << (shift ? 12 : 0);
  return 1;
}

static int decode_ldr_u64(uint32_t insn, int *rt, int *rn, uint64_t *imm) {
  if ((insn & 0xffc00000u) != 0xf9400000u) return 0;
  *rt = (int)(insn & 0x1fu);
  *rn = (int)((insn >> 5) & 0x1fu);
  *imm = (uint64_t)((insn >> 10) & 0xfffu) << 3;
  return 1;
}

static uint32_t read32(const unsigned char *data, uint64_t offset) {
  return ((uint32_t)data[offset]) |
         ((uint32_t)data[offset + 1] << 8) |
         ((uint32_t)data[offset + 2] << 16) |
         ((uint32_t)data[offset + 3] << 24);
}

static uint64_t va_to_off(uint64_t va, uint64_t sec_va, uint64_t sec_off, uint64_t sec_size) {
  if (va < sec_va || va >= sec_va + sec_size) return UINT64_MAX;
  return sec_off + (va - sec_va);
}

static int is_sub_sp(uint32_t insn) {
  return (insn & 0xffc003ffu) == 0xd10003ffu;
}

static int is_stp_fp_lr(uint32_t insn) {
  return (insn & 0xffc07fffu) == 0xa9007bfdu || (insn & 0xffc07fffu) == 0xa9807bfdu;
}

static uint64_t find_function_start(
    const unsigned char *data,
    uint64_t text_off,
    uint64_t text_va,
    uint64_t text_size,
    uint64_t address) {
  uint64_t lower = address > 0x800 ? address - 0x800 : text_va;
  if (lower < text_va) lower = text_va;
  address &= ~3ULL;
  for (uint64_t candidate = address; candidate >= lower; candidate -= 4) {
    uint64_t off = va_to_off(candidate, text_va, text_off, text_size);
    if (off == UINT64_MAX || off + 4 > text_off + text_size) continue;
    uint32_t insn = read32(data, off);
    if (is_stp_fp_lr(insn)) {
      uint64_t prev_off = off >= 4 ? off - 4 : UINT64_MAX;
      if (prev_off != UINT64_MAX && is_sub_sp(read32(data, prev_off))) return candidate - 4;
      return candidate;
    }
    if (is_sub_sp(insn)) {
      for (int step = 1; step <= 4; step++) {
        uint64_t next = off + (uint64_t)step * 4;
        if (next + 4 <= text_off + text_size && is_stp_fp_lr(read32(data, next))) return candidate;
      }
    }
    if (candidate == lower) break;
  }
  return address;
}

typedef struct {
  uint64_t pc;
  uint64_t add_pc;
  uint64_t target;
  int reg;
} Ref;

static void add_ref(Ref **refs, size_t *count, size_t *cap, uint64_t pc, uint64_t add_pc, uint64_t target, int reg) {
  if (*count == *cap) {
    size_t next = *cap ? *cap * 2 : 64;
    Ref *new_refs = (Ref *)realloc(*refs, next * sizeof(Ref));
    if (!new_refs) {
      perror("realloc");
      exit(2);
    }
    *refs = new_refs;
    *cap = next;
  }
  (*refs)[*count].pc = pc;
  (*refs)[*count].add_pc = add_pc;
  (*refs)[*count].target = target;
  (*refs)[*count].reg = reg;
  (*count)++;
}

static Ref *find_adrp_add_refs(
    const unsigned char *data,
    uint64_t text_off,
    uint64_t text_va,
    uint64_t text_size,
    uint64_t target_va,
    size_t *out_count) {
  Ref *refs = NULL;
  size_t count = 0, cap = 0;
  uint64_t stop = text_off + text_size;
  for (uint64_t off = text_off; off + 8 <= stop; off += 4) {
    uint64_t pc = text_va + (off - text_off);
    int reg = 0;
    uint64_t page = 0;
    if (!decode_adrp(read32(data, off), pc, &reg, &page)) continue;
    for (int i = 1; i <= 8 && off + (uint64_t)i * 4 + 4 <= stop; i++) {
      uint64_t add_off = off + (uint64_t)i * 4;
      int rd = 0, rn = 0;
      uint64_t imm = 0;
      if (!decode_add_imm(read32(data, add_off), &rd, &rn, &imm)) continue;
      if (rn == reg && rd == reg && page + imm == target_va) {
        add_ref(&refs, &count, &cap, pc, text_va + (add_off - text_off), target_va, reg);
        break;
      }
    }
  }
  *out_count = count;
  return refs;
}

static Ref *find_adrp_ldr_refs(
    const unsigned char *data,
    uint64_t text_off,
    uint64_t text_va,
    uint64_t text_size,
    uint64_t target_va,
    size_t *out_count) {
  Ref *refs = NULL;
  size_t count = 0, cap = 0;
  uint64_t stop = text_off + text_size;
  for (uint64_t off = text_off; off + 8 <= stop; off += 4) {
    uint64_t pc = text_va + (off - text_off);
    int reg = 0;
    uint64_t page = 0;
    if (!decode_adrp(read32(data, off), pc, &reg, &page)) continue;
    for (int i = 1; i <= 8 && off + (uint64_t)i * 4 + 4 <= stop; i++) {
      uint64_t ldr_off = off + (uint64_t)i * 4;
      int rt = 0, rn = 0;
      uint64_t imm = 0;
      if (!decode_ldr_u64(read32(data, ldr_off), &rt, &rn, &imm)) continue;
      if (rn == reg && rt == reg && page + imm == target_va) {
        add_ref(&refs, &count, &cap, pc, text_va + (ldr_off - text_off), target_va, reg);
        break;
      }
    }
  }
  *out_count = count;
  return refs;
}

static Ref *find_previous_address_loads(
    const unsigned char *data,
    uint64_t text_off,
    uint64_t text_va,
    uint64_t text_size,
    uint64_t before_va,
    int wanted_reg,
    size_t *out_count) {
  Ref *refs = NULL;
  size_t count = 0, cap = 0;
  uint64_t before_off = va_to_off(before_va, text_va, text_off, text_size);
  if (before_off == UINT64_MAX) {
    *out_count = 0;
    return NULL;
  }
  uint64_t start = before_off > 0x500 ? before_off - 0x500 : text_off;
  for (uint64_t off = start; off + 8 <= before_off; off += 4) {
    uint64_t pc = text_va + (off - text_off);
    int reg = 0;
    uint64_t page = 0;
    if (!decode_adrp(read32(data, off), pc, &reg, &page)) continue;
    if (wanted_reg >= 0 && reg != wanted_reg) continue;
    for (int i = 1; i <= 8 && off + (uint64_t)i * 4 + 4 <= before_off; i++) {
      uint64_t add_off = off + (uint64_t)i * 4;
      int rd = 0, rn = 0;
      uint64_t imm = 0;
      if (!decode_add_imm(read32(data, add_off), &rd, &rn, &imm)) continue;
      if (rn == reg && rd == reg) {
        add_ref(&refs, &count, &cap, pc, text_va + (add_off - text_off), page + imm, reg);
        break;
      }
    }
  }
  *out_count = count;
  return refs;
}

static Ref *find_previous_ldr_loads(
    const unsigned char *data,
    uint64_t text_off,
    uint64_t text_va,
    uint64_t text_size,
    uint64_t before_va,
    int wanted_reg,
    size_t *out_count) {
  Ref *refs = NULL;
  size_t count = 0, cap = 0;
  uint64_t before_off = va_to_off(before_va, text_va, text_off, text_size);
  if (before_off == UINT64_MAX) {
    *out_count = 0;
    return NULL;
  }
  uint64_t start = before_off > 0x500 ? before_off - 0x500 : text_off;
  for (uint64_t off = start; off + 8 <= before_off; off += 4) {
    uint64_t pc = text_va + (off - text_off);
    int reg = 0;
    uint64_t page = 0;
    if (!decode_adrp(read32(data, off), pc, &reg, &page)) continue;
    if (wanted_reg >= 0 && reg != wanted_reg) continue;
    for (int i = 1; i <= 8 && off + (uint64_t)i * 4 + 4 <= before_off; i++) {
      uint64_t ldr_off = off + (uint64_t)i * 4;
      int rt = 0, rn = 0;
      uint64_t imm = 0;
      if (!decode_ldr_u64(read32(data, ldr_off), &rt, &rn, &imm)) continue;
      if (rn == reg && rt == reg) {
        add_ref(&refs, &count, &cap, pc, text_va + (ldr_off - text_off), page + imm, reg);
        break;
      }
    }
  }
  *out_count = count;
  return refs;
}

static unsigned char *read_file(const char *path, size_t *out_size) {
  FILE *f = fopen(path, "rb");
  if (!f) {
    perror(path);
    return NULL;
  }
  if (fseek(f, 0, SEEK_END) != 0) {
    perror("fseek");
    fclose(f);
    return NULL;
  }
  long size = ftell(f);
  if (size <= 0) {
    perror("ftell");
    fclose(f);
    return NULL;
  }
  rewind(f);
  unsigned char *data = (unsigned char *)malloc((size_t)size);
  if (!data) {
    perror("malloc");
    fclose(f);
    return NULL;
  }
  if (fread(data, 1, (size_t)size, f) != (size_t)size) {
    perror("fread");
    free(data);
    fclose(f);
    return NULL;
  }
  fclose(f);
  *out_size = (size_t)size;
  return data;
}

int main(int argc, char **argv) {
  const char *path = argc > 1 ? argv[1] : "/opt/wechat/wechat";
  size_t size = 0;
  unsigned char *data = read_file(path, &size);
  if (!data) return 2;
  if (size < sizeof(Elf64_Ehdr) || memcmp(data, ELFMAG, SELFMAG) != 0) {
    fprintf(stderr, "not an ELF64 file\n");
    free(data);
    return 2;
  }

  Elf64_Ehdr *eh = (Elf64_Ehdr *)data;
  Elf64_Shdr *sh = (Elf64_Shdr *)(data + eh->e_shoff);
  const char *shstr = (const char *)(data + sh[eh->e_shstrndx].sh_offset);
  Elf64_Shdr *text = NULL, *rodata = NULL;
  for (int i = 0; i < eh->e_shnum; i++) {
    const char *name = shstr + sh[i].sh_name;
    if (strcmp(name, ".text") == 0) text = &sh[i];
    if (strcmp(name, ".rodata") == 0) rodata = &sh[i];
  }
  if (!text || !rodata) {
    fprintf(stderr, "missing .text or .rodata\n");
    free(data);
    return 2;
  }

  uint64_t anchor_off = UINT64_MAX;
  for (uint64_t off = rodata->sh_offset; off + sizeof(ANCHOR) - 1 <= rodata->sh_offset + rodata->sh_size; off++) {
    if (memcmp(data + off, ANCHOR, sizeof(ANCHOR) - 1) == 0) {
      anchor_off = off;
      break;
    }
  }
  if (anchor_off == UINT64_MAX) {
    fprintf(stderr, "anchor not found\n");
    free(data);
    return 1;
  }
  uint64_t anchor_va = rodata->sh_addr + (anchor_off - rodata->sh_offset);
  printf("anchor_va=0x%llx\n", (unsigned long long)anchor_va);

  for (int argi = 2; argi < argc; argi++) {
    char *end = NULL;
    uint64_t manual = strtoull(argv[argi], &end, 0);
    if (end == argv[argi]) continue;
    size_t manual_count = 0;
    Ref *manual_refs = find_adrp_ldr_refs(
        data, text->sh_offset, text->sh_addr, text->sh_size, manual, &manual_count);
    printf("manual_ldr_target=0x%llx ref_count=%zu\n", (unsigned long long)manual, manual_count);
    for (size_t k = 0; k < manual_count && k < 120; k++) {
      uint64_t fn = find_function_start(
          data, text->sh_offset, text->sh_addr, text->sh_size, manual_refs[k].pc);
      printf("  manual_ref[%zu]=fn=0x%llx ref=0x%llx ldr=0x%llx reg=x%d\n",
             k,
             (unsigned long long)fn,
             (unsigned long long)manual_refs[k].pc,
             (unsigned long long)manual_refs[k].add_pc,
             manual_refs[k].reg);
    }
    free(manual_refs);
  }

  size_t anchor_count = 0;
  Ref *anchor_refs = find_adrp_add_refs(
      data, text->sh_offset, text->sh_addr, text->sh_size, anchor_va, &anchor_count);
  printf("anchor_ref_count=%zu\n", anchor_count);
  for (size_t i = 0; i < anchor_count && i < 64; i++) {
    printf("anchor_ref[%zu]=pc=0x%llx add=0x%llx reg=x%d\n",
           i,
           (unsigned long long)anchor_refs[i].pc,
           (unsigned long long)anchor_refs[i].add_pc,
           anchor_refs[i].reg);

    size_t prev_count = 0;
    Ref *prev = find_previous_address_loads(
        data, text->sh_offset, text->sh_addr, text->sh_size, anchor_refs[i].pc, 0, &prev_count);
    printf("  previous_x0_load_count=%zu\n", prev_count);
    for (size_t j = 0; j < prev_count && j < 8; j++) {
      uint64_t unk = prev[j].target;
      printf("  unk[%zu]=0x%llx from pc=0x%llx add=0x%llx\n",
             j,
             (unsigned long long)unk,
             (unsigned long long)prev[j].pc,
             (unsigned long long)prev[j].add_pc);
      size_t slot_ref_count = 0;
      Ref *slot_refs = find_adrp_add_refs(
          data, text->sh_offset, text->sh_addr, text->sh_size, unk, &slot_ref_count);
      printf("    slot_ref_count=%zu\n", slot_ref_count);
      for (size_t k = 0; k < slot_ref_count && k < 24; k++) {
        uint64_t fn = find_function_start(
            data, text->sh_offset, text->sh_addr, text->sh_size, slot_refs[k].pc);
        printf("    target[%zu]=fn=0x%llx ref=0x%llx add=0x%llx reg=x%d\n",
               k,
               (unsigned long long)fn,
               (unsigned long long)slot_refs[k].pc,
               (unsigned long long)slot_refs[k].add_pc,
               slot_refs[k].reg);
      }
      free(slot_refs);
    }
    free(prev);

    size_t prev_ldr_count = 0;
    Ref *prev_ldr = find_previous_ldr_loads(
        data, text->sh_offset, text->sh_addr, text->sh_size, anchor_refs[i].pc, -1, &prev_ldr_count);
    printf("  previous_ldr_load_count=%zu\n", prev_ldr_count);
    for (size_t j = 0; j < prev_ldr_count && j < 12; j++) {
      uint64_t slot = prev_ldr[j].target;
      printf("  slot[%zu]=0x%llx from pc=0x%llx ldr=0x%llx reg=x%d\n",
             j,
             (unsigned long long)slot,
             (unsigned long long)prev_ldr[j].pc,
             (unsigned long long)prev_ldr[j].add_pc,
             prev_ldr[j].reg);
      size_t ldr_ref_count = 0;
      Ref *ldr_refs = find_adrp_ldr_refs(
          data, text->sh_offset, text->sh_addr, text->sh_size, slot, &ldr_ref_count);
      printf("    ldr_slot_ref_count=%zu\n", ldr_ref_count);
      for (size_t k = 0; k < ldr_ref_count && k < 80; k++) {
        uint64_t fn = find_function_start(
            data, text->sh_offset, text->sh_addr, text->sh_size, ldr_refs[k].pc);
        printf("    ldr_target[%zu]=fn=0x%llx ref=0x%llx ldr=0x%llx reg=x%d\n",
               k,
               (unsigned long long)fn,
               (unsigned long long)ldr_refs[k].pc,
               (unsigned long long)ldr_refs[k].add_pc,
               ldr_refs[k].reg);
      }
      free(ldr_refs);
    }
    free(prev_ldr);
  }
  free(anchor_refs);
  free(data);
  return 0;
}
