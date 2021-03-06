---
layout: page
title: IBM TopView 1.00
permalink: /disks/pcx86/apps/ibm/topview/1.00/
machines:
  - id: ibm5160
    type: pcx86
    config: /devices/pcx86/machine/5160/cga/640kb/mouse/machine.xml
    autoMount:
      A:
        name: PC DOS 2.00 (Disk 1)
      B:
        name: IBM TopView 1.00 (Program)
    autoScript: startKbd
machineScripts:
  startKbd: |
    wait Keyboard DOS;
    type Keyboard "$date\r$time\rB:\rTV\r";
  startMouse: |
    wait Keyboard DOS;
    type Keyboard "$date\r$time\r";
    wait Keyboard;
    sleep 1000;
    select FDC listDrives "A:";
    select FDC listDisks "MS Mouse 5.00 (SYSTEM)";
    loadDisk FDC;
    wait FDC;
    type Keyboard "MOUSE\r";
    sleep 7000;
    type Keyboard "B:\rSETUP\r$50.3\r$20n\r$20y\r$20\r$20\r$20.1\r";
---

IBM TopView 1.00
----------------

From IBM's [August 14, 1984 Announcement Letter](http://www-01.ibm.com/common/ssi/ShowDoc.wss?docURL=/common/ssi/rep_ca/2/897/ENUS284-282/index.html&lang=en&request_locale=en):

> The IBM Personal Computer TopView program and TopView Programmer's ToolKit provide windowing capability with
concurrent execution of multiple applications.

> Highlights:

> - Windowing capability provided.
> - Concurrent execution of multiple applications (multitasking) allowed.
> - A user-supplied 'mouse' as a pointing device.
> - Both text and graphics applications allowed.
> - User may cut/copy and paste between windows.
> - Interactive tutorial and HELP text included.

The machine below is configured to automatically start TopView 1.00 on top of PC DOS 2.00.  If you don't use a mouse,
then you must use TopView's "Keyboard Mouse" support: arrow keys move the cursor, and **Home**, **PgUp**, and **Alt** act
as mouse buttons.  Mouse support is automatically loaded in the [PCjs Debugger](debugger/) configuration.

Directory listings of the original [Program](#directory-of-ibm-topview-100-program) and [Tutorial](#directory-of-ibm-topview-100-tutorial)
disks are provided below.

{% include machine.html id="ibm5160" %}

{% comment %}
To manually start TopView: {% include machine-command.html type='button' label='Load' machine='ibm5160' command='startKbd' %}
{% endcomment %}

### Directory of IBM TopView 1.00 (Program)

	 Volume in drive A is TUP011085  

	Directory of A:\

	TV       PIF     13946 01-10-85  12:00p
	TV       PII      1408 01-10-85  12:00p
	TV       EXT     49731 01-10-85  12:00p
	FDPGM    COM       187 01-10-85  12:00p
	TV       COM     43008 01-10-85  12:00p
	SETUP    BAT        74 01-10-85  12:00p
	ADD      EXT     16384 01-10-85  12:00p
	ATRIBUTE DEF        32 01-10-85  12:00p
	AUTOPIF            369 01-10-85  12:00p
	G        BAT        33 01-10-85  12:00p
	CHANGE   EXT     13568 01-10-85  12:00p
	CLOCK    COM      3682 01-10-85  12:00p
	CLOCK    PLB      2071 01-10-85  12:00p
	COLORS   EXT     10752 01-10-85  12:00p
	COLORS   PIF       369 01-10-85  12:00p
	DELETE   EXT      6400 01-10-85  12:00p
	DOS      EXT     39168 01-10-85  12:00p
	DOSHELP  PLB     10237 01-10-85  12:00p
	DW1      TBL        51 01-10-85  12:00p
	DW2      TBL        51 01-10-85  12:00p
	EW       TBL        55 01-10-85  12:00p
	FD       BAT      6163 01-10-85  12:00p
	FDR      BAT        46 01-10-85  12:00p
	FILTER   EXT      3905 01-10-85  12:00p
	PCW      TBL        55 01-10-85  12:00p
	PDIO     EXT      3072 01-10-85  12:00p
	PDIOKEYB EXT      3072 01-10-85  12:00p
	PDIOMICP EXT      3222 01-10-85  12:00p
	PDIOMICS EXT      3209 01-10-85  12:00p
	PDIOMSY1 EXT      3096 01-10-85  12:00p
	PDIOVIS1 EXT      3214 01-10-85  12:00p
	PE       TBL        44 01-10-85  12:00p
	PROFED   TBL        65 01-10-85  12:00p
	PROGRAMS COM     11520 01-10-85  12:00p
	PROGRAMS HLP      9979 01-10-85  12:00p
	SETSYS   EXT     11008 01-10-85  12:00p
	SYSTEM              84 01-10-85  12:00p
	TUTORPIF           369 01-10-85  12:00p
	WA       TBL        56 01-10-85  12:00p
	WELCOME  EXT      2560 01-10-85  12:00p
	WP       TBL        53 01-10-85  12:00p
	VENDOR-# DO1         0 07-04-83  12:00a
	       42 file(s)     276368 bytes

	Total files listed:
	       42 file(s)     276368 bytes
	                       58368 bytes free

### Directory of IBM TopView 1.00 (Tutorial)

	 Volume in drive A is TUT110784  

	Directory of A:\

	CALC     EXE     56549 11-07-84  12:00p
	CALC     PIF       369 11-07-84  12:00p
	CALC     PLB      5133 11-07-84  12:00p
	ERROR    LIB      8765 11-07-84  12:00p
	GASWAP   BAT       758 11-07-84  12:00p
	INSTRUCT GRA      2540 11-07-84  12:00p
	INSTRUCT WRT      2734 11-07-84  12:00p
	LESSON1  LIB     56019 11-07-84  12:00p
	LESSON2  LIB     10256 11-07-84  12:00p
	LESSON3  LIB     10083 11-07-84  12:00p
	LESSON4  LIB     43072 11-07-84  12:00p
	OCRS     PIF       369 11-07-84  12:00p
	QUD      PNL       121 11-07-84  12:00p
	QUIT     PNL       139 11-07-84  12:00p
	TUTORIAL EXT      6556 11-07-84  12:00p
	TUTORIAL PIF       369 11-07-84  12:00p
	WASWAP   BAT      1190 11-07-84  12:00p
	VENDOR-# DO1         0 07-04-83  12:00a
	       18 file(s)     205022 bytes

	Total files listed:
	       18 file(s)     205022 bytes
	                      146432 bytes free
