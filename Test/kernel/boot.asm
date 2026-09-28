; Boot code for a kernel written in L.
;
; GRUB (or QEMU's -kernel) loads the kernel with the Multiboot protocol and jumps to _start in
; 32-bit protected mode. This switches the CPU to 64-bit long mode, turns on SSE (L uses it for
; floats), sets up a stack and calls kernel_main. The first 1 GiB of memory is identity-mapped,
; so every address below 1 GiB means the same physical address.

MULTIBOOT_MAGIC equ 0x1BADB002
MULTIBOOT_FLAGS equ 0x00000003          ; page-align modules, give us the memory map

section .multiboot
align 4
    dd MULTIBOOT_MAGIC
    dd MULTIBOOT_FLAGS
    dd -(MULTIBOOT_MAGIC + MULTIBOOT_FLAGS)

section .bss
align 4096
pml4:        resb 4096                  ; page tables: PML4 -> PDPT -> PD of 2 MiB pages
pdpt:        resb 4096
page_dir:    resb 4096
stack_bottom:
    resb 65536
stack_top:

section .rodata
align 8
gdt64:
    dq 0                                                    ; null descriptor
.code: equ $ - gdt64
    dq (1 << 43) | (1 << 44) | (1 << 47) | (1 << 53)        ; 64-bit code: executable, present, long mode
.data: equ $ - gdt64
    dq (1 << 41) | (1 << 44) | (1 << 47)                    ; data: writable, present
.pointer:
    dw $ - gdt64 - 1
    dq gdt64

section .text
bits 32
global _start
_start:
    mov esp, stack_top

    ; PML4[0] -> PDPT, PDPT[0] -> page directory (present | writable)
    mov eax, pdpt
    or eax, 0b11
    mov [pml4], eax
    mov eax, page_dir
    or eax, 0b11
    mov [pdpt], eax

    ; 512 page directory entries of 2 MiB each: the first 1 GiB
    xor ecx, ecx
.map_page:
    mov eax, 0x200000
    mul ecx
    or eax, 0b10000011                  ; present | writable | 2 MiB page
    mov [page_dir + ecx * 8], eax
    inc ecx
    cmp ecx, 512
    jne .map_page

    ; physical address extension, the page tables, long mode (EFER.LME), then paging
    mov eax, cr4
    or eax, 1 << 5
    mov cr4, eax
    mov eax, pml4
    mov cr3, eax
    mov ecx, 0xC0000080
    rdmsr
    or eax, 1 << 8
    wrmsr
    mov eax, cr0
    or eax, 1 << 31
    mov cr0, eax

    lgdt [gdt64.pointer]
    jmp gdt64.code:long_mode

bits 64
extern kernel_main
long_mode:
    mov ax, gdt64.data
    mov ss, ax
    mov ds, ax
    mov es, ax
    mov fs, ax
    mov gs, ax

    ; SSE: clear CR0.EM, set CR0.MP, set CR4.OSFXSR and CR4.OSXMMEXCPT
    mov rax, cr0
    and ax, 0xFFFB
    or ax, 0x2
    mov cr0, rax
    mov rax, cr4
    or ax, 3 << 9
    mov cr4, rax

    mov rsp, stack_top
    xor rbp, rbp
    call kernel_main

.hang:
    cli
    hlt
    jmp .hang
