; Program to illustrate flipping from bit-mapped graphics mode to
; text mode and back without losing any of the graphics bit-map.
;
; Assemble with MASM or TASM
;
; By Michael Abrash
;
Stack	segment para stack 'STACK'
	db	512 dup(0)
Stack	ends

GRAPHICS_SEGMENT	equ	0a000h	;mode 10 bit-map segment
TEXT_SEGMENT		equ	0b800h	;mode 3 bit-map segment

SC_INDEX	equ	3c4h	;Sequence Controller Index register
MAP_MASK	equ	2	;index of Map Mask register
GC_INDEX	equ	3ceh	;Graphics Controller Index register
READ_MAP	equ	4	;index of Read Map register

Data	segment para common 'DATA'

GStrikeAnyKeyMsg0	label	byte
	db	0dh, 0ah, 'Graphics mode', 0dh, 0ah
	db	'Strike any key to continue...', 0dh, 0ah, '$'

GStrikeAnyKeyMsg1	label	byte
	db	0dh, 0ah, 'Graphics mode again', 0dh, 0ah
	db	'Strike any key to continue...', 0dh, 0ah, '$'

TStrikeAnyKeyMsg	label	byte
	db	0dh, 0ah, 'Text mode', 0dh, 0ah
	db	'Strike any key to continue...', 0dh, 0ah, '$'

Plane2Save	db	2000h dup (?)	;save area for plane 2 data
					; where font gets loaded
CharAttSave	db	4000 dup (?)	;save area for memory wiped
					; out by character/attribute
					; data in text mode
Data	ends

Code	segment para public 'CODE'
	assume	cs:Code, ds:Data
Start	proc	near
	mov	ax,10h
	int	10h		;select video mode 10h (640x350)
;
; Fill the graphics bit-map with a colored pattern.
;
	cld
	mov	ax,GRAPHICS_SEGMENT
	mov	es,ax
	mov	ah,3		;initial fill pattern
	mov	cx,4		;four planes to fill
	mov	dx,SC_INDEX
	mov	al,MAP_MASK
	out	dx,al		;leave the SC Index pointing to the
	inc	dx		; Map Mask register

FillBitMap:
	mov	al,10h
	shr	al,cl		;generate map mask for this plane
	out	dx,al		;set map mask for this plane
	sub	di,di		;start at offset 0
	mov	al,ah		;get the fill pattern
	push	cx		;preserve plane count
	mov	cx,8000h	;fill 32K words
	rep stosw		;do fill for this plane
	pop	cx		;get back plane count
	shl	ah,1
	shl	ah,1
	loop	FillBitMap
;
; Put up "strike any key" message.
;
	mov	ax,Data
	mov	ds,ax
	mov	dx,offset GStrikeAnyKeyMsg0
	mov	ah,9
	int	21h
;
; Wait for a key.
;
	mov	ah,01h
	int	21h
;
; Save the 8K of plane 2 that will be used by the font.
;
	mov	dx,GC_INDEX
	mov	al,READ_MAP
	out	dx,al
	inc	dx
	mov	al,2
	out	dx,al		;set up to read from plane 2
	mov	ax,Data
	mov	es,ax
	mov	ax,GRAPHICS_SEGMENT
	mov	ds,ax
	sub	si,si
	mov	di,offset Plane2Save
	mov	cx,2000h/2	;save 8K (length of default font)
	rep movsw
;
; Go to text mode without clearing display memory.
;
	mov	ax,083h
	int	10h
;
; Save the text mode bit-map.
;
	mov	ax,Data
	mov	es,ax
	mov	ax,TEXT_SEGMENT
	mov	ds,ax
	sub	si,si
	mov	di,offset CharAttSave
	mov	cx,4000/2	;length of one text screen in words
	rep movsw
;
; Fill the text mode screen with dots and put up "strike any key"
; message.
;
	mov	ax,TEXT_SEGMENT
	mov	es,ax
	sub	di,di
	mov	al,'.'		;fill character
	mov	ah,7		;fill attribute
	mov	cx,4000/2	;length of one text screen in words
	rep stosw
	mov	ax,Data
	mov	ds,ax
	mov	dx,offset TStrikeAnyKeyMsg
	mov	ah,9
	int	21h
;
; Wait for a key.
;
	mov	ah,01h
	int	21h
;
; Restore the text mode screen to the state it was in on entering
; text mode.
;
	mov	ax,Data
	mov	ds,ax
	mov	ax,TEXT_SEGMENT
	mov	es,ax
	mov	si,offset CharAttSave
	sub	di,di
	mov	cx,4000/2	;length of one text screen in words
	rep movsw
;
; Return to mode 10h without clearing display memory.
;
	mov	ax,90h
	int	10h
;
; Restore the portion of plane 2 that was wiped out by the font.
;
	mov	dx,SC_INDEX
	mov	al,MAP_MASK
	out	dx,al
	inc	dx
	mov	al,4
	out	dx,al		;set up to write to plane 2
	mov	ax,Data
	mov	ds,ax
	mov	ax,GRAPHICS_SEGMENT
	mov	es,ax
	mov	si,offset Plane2Save
	sub	di,di
	mov	cx,2000h/2	;restore 8K (length of default font)
	rep movsw
;
; Put up "strike any key" message.
;
	mov	ax,Data
	mov	ds,ax
	mov	dx,offset GStrikeAnyKeyMsg1
	mov	ah,9
	int	21h
;
; Wait for a key before returning to text mode and ending.
;
	mov	ah,01h
	int	21h
	mov	ax,03h
	int	10h
	mov	ah,4ch
	int	21h
Start	endp
Code	ends
	end	Start
