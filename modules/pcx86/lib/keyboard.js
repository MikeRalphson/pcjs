/**
 * @fileoverview Implements the PCx86 Keyboard component
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @copyright © 2012-2018 Jeff Parsons
 *
 * This file is part of PCjs, a computer emulation software project at <http://pcjs.org/>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every modified copy of this work
 * and to display that copyright notice when the software starts running; see COPYRIGHT in
 * <http://pcjs.org/modules/shared/lib/defines.js>.
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of PCjs
 * for purposes of the GNU General Public License, and the author does not claim any copyright
 * as to their contents.
 */

"use strict";

if (NODE) {
    var Str         = require("../../shared/lib/strlib");
    var Usr         = require("../../shared/lib/usrlib");
    var Web         = require("../../shared/lib/weblib");
    var Component   = require("../../shared/lib/component");
    var Keys        = require("../../shared/lib/keys");
    var State       = require("../../shared/lib/state");
    var PCX86       = require("./defines");
    var Interrupts  = require("./interrupts");
    var Messages    = require("./messages");
    var ChipSet     = require("./chipset");
    var ROMX86      = require("./rom");
}

/**
 * class Keyboard
 * @unrestricted (allows the class to define properties, both dot and named, outside of the constructor)
 */
class Keyboard extends Component {
    /**
     * Keyboard(parmsKbd)
     *
     * The Keyboard component can be configured with the following (parmsKbd) properties:
     *
     *      model: keyboard model string, which must match one of the values listed in Keyboard.MODELS:
     *
     *          "US83" (default)
     *          "US84"
     *          "US101" (not fully supported yet)
     *
     *      autoType: string of keys to automatically inject when the machine is ready (undefined if none)
     *
     *      softKeys: boolean set to true to enable the machine's soft keyboard, if any (default is false)
     *
     * Its main purpose is to receive binding requests for various keyboard events, and to use those events
     * to simulate the PC's keyboard hardware.
     *
     * TODO: Consider finishing 101-key keyboard support, even though that's sort of a "PS/2" thing, and I'm not
     * really interested in taking PCjs into the PS/2 line (that's also why we still support only serial mice, not
     * "PS/2" mice).  In addition, all keyboards *after* the original PC 83-key keyboard supported their own unique
     * scan code sets, which the 8042 controller would then convert to PC-compatible scan codes.  That's probably
     * more important to implement, because that feature was introduced with the 84-key keyboard on the PC AT.
     *
     * @this {Keyboard}
     * @param {Object} parmsKbd
     */
    constructor(parmsKbd)
    {
        super("Keyboard", parmsKbd, Messages.KBD);

        this.setModel(parmsKbd['model']);

        this.fMobile = Web.isMobile("!iPad");
        this.printMessage("mobile keyboard support: " + (this.fMobile? "true" : "false"));

        /*
         * This flag (formerly fMSIE, for all versions of Microsoft Internet Explorer, up to and including v11)
         * has been updated to reflect the Microsoft Windows *platform* rather than the *browser*, because it appears
         * that all Windows-based browsers (at least now, as of 2018) have the same behavior with respect to "lock"
         * keys: keys like CAPS-LOCK generate both UP and DOWN events on every press.  On other platforms (eg, macOS),
         * those keys generate only a DOWN event when "locking" and only an UP event when "unlocking".
         */
        this.fMSWindows = Web.isUserAgent("Windows");

        /*
         * This is count of the number of "soft keyboard" keys present.  At the moment, its only
         * purpose is to signal findBinding() whether to waste any time looking for SOFTCODE matches.
         */
        this.cSoftCodes = 0;
        this.fSoftKeyboard = parmsKbd['softKeys'];
        this.controlSoftKeyboard = null;
        this.controlTextKeyboard = null;

        /*
         * Updated by onFocusChange()
         */
        this.fHasFocus = true;

        /*
         * This is true whenever the physical Escape key is disabled (eg, by pointer locking code),
         * giving us the opportunity to map a different physical key to machine's virtual Escape key.
         */
        this.fEscapeDisabled = false;

        /*
         * This is set whenever we notice a discrepancy between our internal CAPS_LOCK state and its
         * apparent state; we check whenever aKeysActive has been emptied.
         */
        this.fToggleCapsLock = false;

        /*
         * New unified approach to key event processing: When we process a key on the "down" event,
         * we check the aKeysActive array: if the key is already active, do nothing; otherwise, insert
         * it into the table, generate the "make" scan code(s), and set a timeout for "repeat" if it's
         * a repeatable key (most are).
         *
         * Similarly, when a key goes "up", if it's already not active, do nothing; otherwise, generate
         * the "break" scan code(s), cancel any pending timeout, and remove it from the active key table.
         *
         * If a "press" event is received, then if the key is already active, remove it and (re)insert
         * it at the head of the table, generate the "make" scan code(s), set nRepeat to -1, and set a
         * timeout for "break".
         *
         * This requires an aKeysActive array that keeps track of the status of every active key; only the
         * first entry in the array is allowed to repeat.  Each entry is a key object with the following
         * properties:
         *
         *      simCode:    our simulated keyCode from onKeyChange or onKeyPress
         *      bitsState:  snapshot of the current bitsState when the key is added (currently not used)
         *      fDown:      next state to simulate (true for down, false for up)
         *      nRepeat:    > 0 if timer should generate more "make" scan code(s), -1 for "break" scan code(s)
         *      timer:      timer for next key operation, if any
         *
         * Keys are inserted at the head of aKeysActive, using splice(0, 0, key), but not before zeroing
         * nRepeat of any repeating key that already occupies the head (index 0), so that at most only one
         * key (ie, the most recent) will ever be in a repeating state.
         *
         * IBM PC keyboard repeat behavior: when pressing CTRL, then C, and then releasing CTRL while still
         * holding C, the repeated CTRL_C characters turn into 'c' characters.  We emulate that behavior.
         * However, when pressing C, then CTRL, all repeating stops: not a single CTRL_C is generated, and
         * even if the CTRL is released before the C, no more more 'c' characters are generated either.
         * We do NOT fully emulate that behavior -- we DO stop the repeating, but we also generate one CTRL_C.
         * More investigation is required, because I need to confirm whether the IBM keyboard automatically
         * "breaks" all non-shift keys before it "makes" the CTRL.
         */
        this.aKeysActive = [];

        this.msTransmit      = 10;          // minimum number of milliseconds between data transmissions
        this.msAutoRepeat    = 500;
        this.msNextRepeat    = 100;
        this.msAutoRelease   = 50;
        this.msInjectDefault = 100;         // number of milliseconds between injected keystrokes
        this.msInjectDelay   = 0;           // set by the initial injectKeys() call
        this.msDoubleClick   = 250;         // used by mousedown/mouseup handlers to soft-lock modifier keys
        this.cKeysPressed    = 0;           // count of keys pressed since the last time it was reset
        this.softCodeKeys    = Object.keys(Keyboard.SOFTCODES);

        /*
         * Remove all single-character SOFTCODE keys from the softCodeKeys array, because those SOFTCODES
         * are not supported by injectKeys(); they can be specified normally using their single-character identity.
         */
        for (let i = 0; i < this.softCodeKeys.length; i++) {
            if (this.softCodeKeys[i].length < 2) {
                this.softCodeKeys.splice(i, 1);
                i--;
            }
        }

        /*
         * autoType records the machine's specified autoType sequence, if any, and when injectInit() is called
         * with the appropriate INJECTION signal, injectInit() pass autoType to injectKeys().
         */
        this.autoType = parmsKbd['autoType'];
        this.fDOSReady = false;
        this.fnDOSReady = this.fnInjectReady = null;
        this.nInjection = Keyboard.INJECTION.ON_INPUT;

        /*
         * HACK: We set fAllDown to false to ignore all down/up events for keys not explicitly marked as ONDOWN;
         * even though that prevents those keys from being repeated properly (ie, at the simulation's repeat rate
         * rather than the browser's repeat rate), it's the safest thing to do when dealing with international keyboards,
         * because our mapping tables are designed for US keyboards, and testing all the permutations of international
         * keyboards and web browsers is more work than I can take on right now.  TODO: Dig into this some day.
         */
        this.fAllDown = false;

        this['exports'] = {
            'type':         this.injectKeys,
            'wait':         this.waitReady
        };

        this.setReady();
    }

    /**
     * setBinding(sHTMLType, sBinding, control, sValue)
     *
     * @this {Keyboard}
     * @param {string} sHTMLType is the type of the HTML control (eg, "button", "list", "text", "submit", "textarea", "canvas")
     * @param {string} sBinding is the value of the 'binding' parameter stored in the HTML control's "data-value" attribute (eg, "esc")
     * @param {HTMLElement} control is the HTML control DOM object (eg, HTMLButtonElement)
     * @param {string} [sValue] optional data value
     * @return {boolean} true if binding was successful, false if unrecognized binding request
     */
    setBinding(sHTMLType, sBinding, control, sValue)
    {
        let kbd = this;
        let className;
        let id = sHTMLType + '-' + sBinding;
        let controlText = /** @type {HTMLTextAreaElement} */ (control);

        if (this.bindings[id] === undefined) {
            switch (sBinding) {
            case "keyboard":
                try {
                    /*
                     * TODO: Fix this rather fragile code, which depends on the current structure of the given xxxx-softkeys.xml
                     */
                    let controlSoftKeyboard = control.parentElement.parentElement.nextElementSibling;
                    className = controlSoftKeyboard.className;
                    if (this.fMobile != (className.indexOf('mobile') >= 0)) {
                        controlSoftKeyboard = controlSoftKeyboard.nextElementSibling;
                    }
                    if (controlSoftKeyboard) {
                        this.controlSoftKeyboard = controlSoftKeyboard;
                        if (this.fSoftKeyboard != null) {
                            this.enableSoftKeyboard(this.fSoftKeyboard);
                        } else {
                            this.fSoftKeyboard = (controlSoftKeyboard.style.display != "none");
                        }
                        control.onclick = function onToggleKeyboard(event) {
                            kbd.enableSoftKeyboard(!kbd.fSoftKeyboard);
                        };
                        /*
                         * This is added simply to prevent the page from "zooming" around if you accidentally touch between the keys.
                         */
                        if ('ontouchstart' in window) {
                            controlSoftKeyboard.ontouchstart = function onTouchKeyboard(event) {
                                event.preventDefault();
                            };
                        }
                    }
                } catch(err) {}
                return true;

            case "screen":
                /*
                 * This is a special binding that the Video component uses to effectively bind its screen to the
                 * entire keyboard; eg:
                 *
                 *      this.kbd.setBinding(this.inputTextArea? "textarea" : "canvas", "screen", this.inputScreen);
                 *
                 * Recording the binding ID prevents multiple controls (or components) from attempting to erroneously
                 * bind a control to the same ID, but in the case of a "dual display" configuration, we actually want
                 * to allow BOTH video components to call setBinding() for "screen", so that it doesn't matter which
                 * display the user gives focus to.
                 *
                 *      this.bindings[id] = control;
                 */
                if (sHTMLType == "textarea") {
                    this.controlTextKeyboard = controlText;
                }
                controlText.onkeydown = function onKeyDown(event) {
                    return kbd.onKeyChange(event, true);
                };
                controlText.onkeypress = function onKeyPressKbd(event) {
                    return kbd.onKeyPress(event);
                };
                controlText.onkeyup = function onKeyUp(event) {
                    return kbd.onKeyChange(event, false);
                };
                return true;

            case "caps-lock":
                if (sHTMLType == 'led') {
                    this.bindings[id] = control;
                    control.onclick = function onClickCapsLock(event) {
                        event.preventDefault();
                        if (kbd.cmp) kbd.cmp.updateFocus();
                        return kbd.toggleCapsLock();
                    };
                    return true;
                }
                /* falls through */

            case "num-lock":
                if (sHTMLType == 'led') {
                    this.bindings[id] = control;
                    control.onclick = function onClickNumLock(event) {
                        event.preventDefault();
                        if (kbd.cmp) kbd.cmp.updateFocus();
                        return kbd.toggleNumLock();
                    };
                    return true;
                }
                /* falls through */

            case "scroll-lock":
                if (sHTMLType == 'led') {
                    this.bindings[id] = control;
                    control.onclick = function onClickScrollLock(event) {
                        event.preventDefault();
                        if (kbd.cmp) kbd.cmp.updateFocus();
                        return kbd.toggleScrollLock();
                    };
                    return true;
                }
                /* falls through */

            default:
                /*
                 * Maintain support for older button codes; eg, map button code "ctrl-c" to CLICKCODE "CTRL_C"
                 */
                let sCode = sBinding.toUpperCase().replace(/-/g, '_');
                if (Keyboard.CLICKCODES[sCode] !== undefined && sHTMLType == "button") {
                    this.bindings[id] = controlText;
                    if (MAXDEBUG) console.log("binding click-code '" + sCode + "'");
                    controlText.onclick = function(kbd, sKey, simCode) {
                        return function onKeyboardBindingClick(event) {
                            if (kbd.messageEnabled()) kbd.printMessage(sKey + " clicked", Messages.EVENT | Messages.KEY);
                            event.preventDefault();                 // preventDefault() is necessary...
                            if (kbd.cmp) kbd.cmp.updateFocus();     // ...for the updateFocus() call to actually work
                            kbd.sInjectBuffer = "";                 // key events should stop any injection currently in progress
                            kbd.updateShiftState(simCode, true);    // future-proofing if/when any LOCK keys are added to CLICKCODES
                            kbd.addActiveKey(simCode, true);
                        };
                    }(this, sCode, Keyboard.CLICKCODES[sCode]);
                    return true;
                }
                else if (Keyboard.SOFTCODES[sBinding] !== undefined) {
                    /*
                     * TODO: Fix this rather fragile code, which depends on the current structure of the given xxxx-softkeys.xml
                     */
                    className = control.parentElement.parentElement.className;
                    if (className && this.fMobile != (className.indexOf('mobile') >= 0)) {
                        break;
                    }
                    this.cSoftCodes++;
                    this.bindings[id] = controlText;
                    if (MAXDEBUG) console.log("binding soft-code '" + sBinding + "'");
                    let msLastEvent = 0, nClickState = 0;
                    let fStateKey = (Keyboard.KEYSTATES[Keyboard.SOFTCODES[sBinding]] <= Keyboard.STATE.ALL_MODIFIERS);
                    let fnDown = function(kbd, sKey, simCode) {
                        return function onKeyboardBindingDown(event) {
                            let msDelta = event.timeStamp - msLastEvent;
                            nClickState = (nClickState && msDelta < kbd.msDoubleClick? (nClickState << 1) : 1);
                            msLastEvent = event.timeStamp;
                            event.preventDefault();                 // preventDefault() is necessary to avoid "zooming" when you type rapidly
                            kbd.sInjectBuffer = "";                 // key events should stop any injection currently in progress
                            kbd.addActiveKey(simCode);
                        };
                    }(this, sBinding, Keyboard.SOFTCODES[sBinding]);
                    let fnUp = function(kbd, sKey, simCode) {
                        return function onKeyboardBindingUp(event) {
                            if (nClickState) {
                                let msDelta = event.timeStamp - msLastEvent;
                                nClickState = (fStateKey && msDelta < kbd.msDoubleClick? (nClickState << 1) : 0);
                                msLastEvent = event.timeStamp;
                                if (nClickState < 8) {
                                    kbd.removeActiveKey(simCode);
                                } else {
                                    if (MAXDEBUG) console.log("soft-locking '" + sBinding + "'");
                                    nClickState = 0;
                                }
                            }
                        };
                    }(this, sBinding, Keyboard.SOFTCODES[sBinding]);
                    if ('ontouchstart' in window) {
                        controlText.ontouchstart = fnDown;
                        controlText.ontouchend = fnUp;
                    } else {
                        controlText.onmousedown = fnDown;
                        controlText.onmouseup = controlText.onmouseout = fnUp;
                    }
                    return true;
                }
                else if (sValue) {
                    /*
                     * Instead of just having a dedicated "test" control, we now treat any unrecognized control with
                     * a "value" attribute as a test control.  The only caveat is that such controls must have binding IDs
                     * that do not conflict with predefined controls (which, of course, is the only way you can get here).
                     */
                    this.bindings[id] = control;
                    control.onclick = function onClickTest(event) {
                        event.preventDefault();                     // preventDefault() is necessary...
                        if (kbd.cmp) kbd.cmp.updateFocus();         // ...for the updateFocus() call to actually work
                        return kbd.injectKeys(sValue);
                    };
                    return true;
                }
                break;
            }
        }
        return false;
    }

    /**
     * findBinding(simCode, sType, fDown)
     *
     * TODO: This function is woefully inefficient, because the SOFTCODES table is designed for converting
     * soft key presses into SIMCODES, whereas this function is doing the reverse: looking for the soft key,
     * if any, that corresponds to a SIMCODE, simply so we can provide visual feedback of keys activated
     * by other means (eg, real keyboard events, button clicks that generate key sequences like CTRL-ALT-DEL,
     * etc).
     *
     * To minimize this function's cost, we would want to dynamically create a reverse-lookup table after
     * all the setBinding() calls for the soft keys have been established; note that the reverse-lookup table
     * would contain MORE entries than the SOFTCODES table, because there are multiple simCodes that correspond
     * to a given soft key (eg, '1' and '!' both map to the same soft key).
     *
     * @this {Keyboard}
     * @param {number} simCode
     * @param {string} sType is the type of control (eg, "button" or "key")
     * @param {boolean} [fDown] is true if the key is going down, false if up, or undefined if unchanged
     * @return {Object} is the HTML control DOM object (eg, HTMLButtonElement), or undefined if no such control exists
     */
    findBinding(simCode, sType, fDown)
    {
        let control;
        if (this.cSoftCodes && this.fSoftKeyboard) {
            for (let code in Keys.SHIFTED_KEYCODES) {
                if (simCode == Keys.SHIFTED_KEYCODES[code]) {
                    simCode = +code;
                    code = Keys.NONASCII_KEYCODES[code];
                    if (code) simCode = +code;
                    break;
                }
            }
            /*
             * TODO: Create a table that maps these SIMCODEs to the corresponding entries in the SOFTCODES table;
             * these SIMCODEs can be generated by CLICKCODEs or by the special key remapping HACKs in onKeyChange().
             */
            if (simCode == Keyboard.SIMCODE.CTRL_PAUSE) {
                simCode = Keyboard.SIMCODE.NUM_LOCK;
            }
            else if (simCode == Keyboard.SIMCODE.CTRL_BREAK) {
                simCode = Keyboard.SIMCODE.SCROLL_LOCK;
            }
            else if (simCode == Keyboard.SIMCODE.CTRL_ALT_DEL) {
                simCode = Keyboard.SIMCODE.DEL;
            }
            else if (simCode == Keyboard.SIMCODE.CTRL_ALT_INS) {
                simCode = Keyboard.SIMCODE.INS;
            }
            else if (simCode == Keyboard.SIMCODE.CTRL_ALT_ADD) {
                simCode = Keyboard.SIMCODE.NUM_ADD;
            }
            else if (simCode == Keyboard.SIMCODE.CTRL_ALT_SUB) {
                simCode = Keyboard.SIMCODE.NUM_SUB;
            }
            for (let sBinding in Keyboard.SOFTCODES) {
                if (Keyboard.SOFTCODES[sBinding] == simCode || Keyboard.SOFTCODES[sBinding] == this.toUpperKey(simCode)) {
                    let id = sType + '-' + sBinding;
                    control = this.bindings[id];
                    if (control && fDown !== undefined) {
                        this.setSoftKeyState(control, fDown);
                    }
                    break;
                }
            }
        }
        return control;
    }

    /**
     * initBus(cmp, bus, cpu, dbg)
     *
     * @this {Keyboard}
     * @param {Computer} cmp
     * @param {Bus} bus
     * @param {CPUX86} cpu
     * @param {DebuggerX86} dbg
     */
    initBus(cmp, bus, cpu, dbg)
    {
        this.cmp = cmp;
        this.bus = bus;
        this.cpu = cpu;
        this.dbg = dbg;

        let kbd = this;
        this.timerInject = this.cpu.addTimer(this.id + ".inject", function injectKeysTimer() {
            kbd.injectKeys();
        });

        this.timerTransmit = this.cpu.addTimer(this.id + ".transmit", function transmitDataTimer() {
            kbd.transmitData();
        });

        this.chipset = cmp.getMachineComponent("ChipSet");
        this.autoType = cmp.getMachineParm('autoType') || this.autoType;

        let softKeys = cmp.getMachineParm('softKeys');
        if (softKeys) this.enableSoftKeyboard(softKeys != "false");

        cpu.addIntNotify(Interrupts.DOS, this.intDOS.bind(this));
    }

    /**
     * start()
     *
     * Notification from the Computer that it's starting.
     *
     * @this {Keyboard}
     */
    start()
    {
        this.injectInit(Keyboard.INJECTION.ON_START);
    }

    /**
     * intDOS()
     *
     * Monitors selected DOS interrupts for signals to initialize 'autoType' injection.
     *
     * @this {Keyboard}
     * @param {number} addr
     * @return {boolean} true to proceed with the INT 0x21 software interrupt, false to skip
     */
    intDOS(addr)
    {
        let AH = (this.cpu.regEAX >> 8) & 0xff;
        if (AH == 0x0A) {
            this.fDOSReady = true;
            if (this.fnDOSReady) {
                this.fnDOSReady();
                this.fnDOSReady = null;
                this.fDOSReady = false;
            } else {
                this.injectInit(Keyboard.INJECTION.ON_INPUT);
            }
        }
        return true;
    }

    /**
     * notifyEscape(fDisabled, fAllDown)
     *
     * When ESC is used by the browser to disable pointer lock, this gives us the option of mapping a different key to ESC.
     *
     * @this {Keyboard}
     * @param {boolean} fDisabled
     * @param {boolean} [fAllDown] (an experimental option to re-enable processing of all onkeydown/onkeyup events)
     */
    notifyEscape(fDisabled, fAllDown)
    {
        this.fEscapeDisabled = fDisabled;
        if (fAllDown !== undefined) this.fAllDown = fAllDown;
    }

    /**
     * resetDevice()
     *
     * @this {Keyboard}
     */
    resetDevice()
    {
        /*
         * TODO: There's more to reset, like LED indicators, default type rate, and emptying the scan code buffer.
         */
        this.printMessage("keyboard reset", Messages.KBD | Messages.PORT);
        this.abBuffer = [];
        this.setResponse(Keyboard.CMDRES.BAT_OK);
    }

    /**
     * setModel(sModel)
     *
     * This breaks a model string (eg, "US83") into two parts: modelCountry (eg, "US") and modelKeys (eg, 83).
     * If the model string isn't recognized, we use Keyboard.MODELS[0] (ie, the first entry in the model array).
     *
     * @this {Keyboard}
     * @param {string|undefined} sModel
     */
    setModel(sModel)
    {
        let iModel = 0;
        this.model = null;
        if (typeof sModel == "string") {
            this.model = sModel.toUpperCase();
            iModel = Keyboard.MODELS.indexOf(this.model);
            if (iModel < 0) iModel = 0;
        }
        sModel = Keyboard.MODELS[iModel];
        if (sModel) {
            this.modelCountry = sModel.substr(0, 2);
            this.modelKeys = parseInt(sModel.substr(2), 10);
        }
    }

    /**
     * checkBuffer(b)
     *
     * This is the ChipSet's interface to let us know it's ready.
     *
     * @this {Keyboard}
     * @param {number} [b] (set to the data, if any, that the ChipSet just delivered)
     */
    checkBuffer(b)
    {
        let fReady = false;
        if (b) {
            /*
             * The following hack is for the 5170 ROM BIOS keyboard diagnostic, which expects the keyboard
             * to report BAT_OK immediately after the ACK from a RESET command.  The BAT_OK response should already
             * be in the keyboard's buffer; we just need to give it a little nudge.
             */
            if (b == Keyboard.CMDRES.ACK) {
                fReady = true;
            }
            if (this.cpu) {
                this.cpu.setTimer(this.timerTransmit, this.msTransmit, true);
            }
        }
        this.transmitData(fReady);
    }

    /**
     * flushBuffer()
     *
     * This is the ChipSet's interface to flush any buffered keyboard data.
     *
     * @this {Keyboard}
     */
    flushBuffer()
    {
        this.abBuffer = [];
        if (!COMPILED && this.messageEnabled()) this.printMessage("keyboard data flushed");
    }

    /**
     * receiveCmd(bCmd)
     *
     * This is the ChipSet's interface for controlling "Model M" keyboards (ie, those used with MODEL_5170
     * machines).  Commands are delivered through the ChipSet's 8042 Keyboard Controller.
     *
     * @this {Keyboard}
     * @param {number} bCmd should be one of the Keyboard.CMD.* command codes (Model M keyboards only)
     * @return {number} response should be one of the Keyboard.CMDRES.* response codes, or -1 if unrecognized
     */
    receiveCmd(bCmd)
    {
        let b = -1;

        if (!COMPILED && this.messageEnabled()) this.printMessage("receiveCmd(" + Str.toHexByte(bCmd) + ")");

        switch(this.bCmdPending || bCmd) {

        case Keyboard.CMD.RESET:            // 0xFF
            b = Keyboard.CMDRES.ACK;
            this.resetDevice();
            break;

        case Keyboard.CMD.SET_RATE:         // 0xF3
            if (this.bCmdPending) {
                this.setRate(bCmd);
                bCmd = 0;
            }
            this.setResponse(Keyboard.CMDRES.ACK);
            this.bCmdPending = bCmd;
            break;

        case Keyboard.CMD.SET_LEDS:         // 0xED
            if (this.bCmdPending) {
                this.setLEDs(bCmd);
                bCmd = 0;
            }
            this.setResponse(Keyboard.CMDRES.ACK);
            this.bCmdPending = bCmd;
            break;

        default:
            if (!COMPILED) this.printMessage("receiveCmd(): unrecognized command");
            break;
        }

        return b;
    }

    /**
     * setEnabled(fData, fClock)
     *
     * This is the ChipSet's interface for toggling keyboard "data" and "clock" lines.
     *
     * For MODEL_5150 and MODEL_5160 machines, this function is called from the ChipSet's PPI_B
     * output handler.  For MODEL_5170 machines, this function is called when selected CMD
     * "data bytes" have been written.
     *
     * @this {Keyboard}
     * @param {boolean} fData is true if the keyboard simulated data line should be enabled
     * @param {boolean} fClock is true if the keyboard's simulated clock line should be enabled
     * @return {boolean} true if keyboard was re-enabled, false if not (or no change)
     */
    setEnabled(fData, fClock)
    {
        let fReset = false;
        if (this.fClock !== fClock) {
            if (!COMPILED && this.messageEnabled(Messages.KBD | Messages.PORT)) {
                this.printMessage("keyboard clock line changing to " + fClock, true);
            }
            /*
             * Toggling the clock line low and then high signals a "reset", which we acknowledge once the
             * data line is high as well.
             */
            this.fClock = this.fResetOnEnable = fClock;
        }
        if (this.fData !== fData) {
            if (!COMPILED && this.messageEnabled(Messages.KBD | Messages.PORT)) {
                this.printMessage("keyboard data line changing to " + fData, true);
            }
            this.fData = fData;
            if (fData && !this.fResetOnEnable) {
                this.transmitData(true);
            }
        }
        if (this.fData && this.fResetOnEnable) {
            this.resetDevice();
            this.fResetOnEnable = false;
            fReset = true;
        }
        return fReset;
    }

    /**
     * setLEDs(b)
     *
     * This processes the option byte received after a SET_LEDS command byte.
     *
     * @this {Keyboard}
     * @param {number} b
     */
    setLEDs(b)
    {
        this.bLEDs = b;             // TODO: Implement
    }

    /**
     * setRate(b)
     *
     * This processes the rate parameter byte received after a SET_RATE command byte.
     *
     * @this {Keyboard}
     * @param {number} b
     */
    setRate(b)
    {
        this.bRate = b;             // TODO: Implement
    }

    /**
     * setResponse(b)
     *
     * @this {Keyboard}
     * @param {number} b
     */
    setResponse(b)
    {
        if (this.chipset) {
            this.abBuffer.unshift(b);
            if (!COMPILED && this.messageEnabled()) this.printMessage("keyboard response " + Str.toHexByte(b) + " buffered");
            this.transmitData();
        }
    }

    /**
     * transmitData(fReady)
     *
     * This manages communication with the ChipSet's receiveKbdData() interface.
     *
     * @this {Keyboard}
     * @param {boolean} [fReady]
     */
    transmitData(fReady)
    {
        if (this.chipset) {
            if (fReady || !this.cpu.isTimerSet(this.timerTransmit)) {
                /*
                 * The original IBM PC BIOS performs a "stuck key" test by resetting the keyboard
                 * (by toggling the CLOCK line), then checking for a BAT_OK response (0xAA), and then
                 * clocking in the next byte (by toggling the DATA line); if that next byte isn't 0x00,
                 * then the BIOS reports a "301" error, along with "AA" if we failed to properly flush
                 * the BAT_OK response.
                 */
                let b = this.abBuffer.length? this.abBuffer[0] : 0;
                if (this.chipset.receiveKbdData(b)) {
                    if (!COMPILED && this.messageEnabled()) this.printMessage("keyboard data " + Str.toHexByte(b) + " delivered");
                    this.abBuffer.shift();
                }
                if (b) this.cpu.setTimer(this.timerTransmit, this.msTransmit);
            }
        }
    }

    /**
     * powerUp(data, fRepower)
     *
     * @this {Keyboard}
     * @param {Object|null} data
     * @param {boolean} [fRepower]
     * @return {boolean} true if successful, false if failure
     */
    powerUp(data, fRepower)
    {
        if (!fRepower) {
            /*
             * TODO: Save/restore support for Keyboard is the barest minimum.  In fact, originally, I wasn't
             * saving/restoring anything, and that was OK, but if we don't at least re-initialize fClock/fData,
             * we can get a spurious reset following a restore.  In an ideal world, we might choose to save/restore
             * abBuffer as well, but realistically, I think it's going to be safer to always start with an
             * empty buffer--and who's going to notice anyway?
             *
             * So, like Debugger, we deviate from the typical save/restore pattern: instead of reset OR restore,
             * we always reset and then perform a (very limited) restore.
             */
            this.reset();
            if (data && this.restore) {
                if (!this.restore(data)) return false;
            }
        }
        return true;
    }

    /**
     * powerDown(fSave, fShutdown)
     *
     * @this {Keyboard}
     * @param {boolean} [fSave]
     * @param {boolean} [fShutdown]
     * @return {Object|boolean} component state if fSave; otherwise, true if successful, false if failure
     */
    powerDown(fSave, fShutdown)
    {
        return fSave? this.save() : true;
    }

    /**
     * reset()
     *
     * @this {Keyboard}
     */
    reset()
    {
        /*
         * If no keyboard model was specified, our initial setModel() call will select the "US83" keyboard as the
         * default, but now that the ChipSet is initialized, we can pick a better default, based on the ChipSet model.
         */
        if (!this.model && this.chipset) {
            switch(this.chipset.model) {
            case ChipSet.MODEL_5150:
            case ChipSet.MODEL_5160:
                this.setModel(Keyboard.MODELS[0]);
                break;
            case ChipSet.MODEL_5170:
            default:
                this.setModel(Keyboard.MODELS[1]);
                break;
            }
        }
        this.initState();
    }

    /**
     * save()
     *
     * This implements save support for the Keyboard component.
     *
     * @this {Keyboard}
     * @return {Object}
     */
    save()
    {
        let state = new State(this);
        state.set(0, this.saveState());
        return state.data();
    }

    /**
     * restore(data)
     *
     * This implements restore support for the Keyboard component.
     *
     * @this {Keyboard}
     * @param {Object} data
     * @return {boolean} true if successful, false if failure
     */
    restore(data)
    {
        return this.initState(data[0]);
    }

    /**
     * initState(data)
     *
     * @this {Keyboard}
     * @param {Array} [data]
     * @return {boolean} true if successful, false if failure
     */
    initState(data)
    {
        /*
         * Empty the injection buffer (an injection could have been in progress on any reset after the first).
         */
        this.sInjectBuffer = "";
        this.nInjection = Keyboard.INJECTION.ON_INPUT;

        if (!data) {
            data = [];
        } else {
            /*
             * If there is a predefined state for this machine, then the assumption is that any injection
             * sequence can be injected as soon as the machine starts.  Any other kind of state must disable
             * injection, because injection depends on the machine being in a known state.
             */
            this.nInjection = this.cmp.sStatePath? Keyboard.INJECTION.ON_START : Keyboard.INJECTION.NONE;
        }

        let i = 0;
        this.fClock = data[i++];
        this.fData = data[i];
        this.bCmdPending = 0;       // when non-zero, a command is pending (eg, SET_LED or SET_RATE)

        /*
         * The current (assumed) physical (and simulated) states of the various shift/lock keys.
         *
         * TODO: Determine how (or whether) we can query the browser's initial shift/lock key states.
         */
        this.bitsState = this.bitsStateSim = 0;

        /*
         * New scan codes are "pushed" onto abBuffer and then "shifted" off.
         */
        this.abBuffer = [];

        return true;
    }

    /**
     * saveState()
     *
     * @this {Keyboard}
     * @return {Array}
     */
    saveState()
    {
        let data = [];
        data[0] = this.fClock;
        data[1] = this.fData;
        return data;
    }

    /**
     * enableSoftKeyboard(fEnable)
     *
     * In addition to enabling or disabling our own soft keyboard (if any), this also attempts to disable or enable
     * (as appropriate) the textarea control (if any) that machines use to trigger a touch device's built-in keyboard.
     *
     * @this {Keyboard}
     * @param {boolean} fEnable
     */
    enableSoftKeyboard(fEnable)
    {
        if (this.controlSoftKeyboard) {
            if (!fEnable) {
                this.controlSoftKeyboard.style.display = "none";
                if (this.controlTextKeyboard) {
                    this.controlTextKeyboard.readOnly = false;
                }
            } else {
                this.controlSoftKeyboard.style.display = "block";
                if (this.controlTextKeyboard) {
                    this.controlTextKeyboard.readOnly = true;
                }
            }
        }
        this.fSoftKeyboard = fEnable;
    }

    /**
     * setSoftKeyState(control, f)
     *
     * @this {Keyboard}
     * @param {HTMLElement} control is an HTML control DOM object
     * @param {boolean} f is true if the key represented by e should be "on", false if "off"
     */
    setSoftKeyState(control, f)
    {
        control.style.color = (f? "#ffffff" : "#000000");
        control.style.backgroundColor = (f? "#000000" : "#ffffff");
    }

    /**
     * addScanCode(bScan)
     *
     * @this {Keyboard}
     * @param {number} bScan
     */
    addScanCode(bScan)
    {
        /*
         * Prepare for the possibility that our reset() function may not have been called yet.
         *
         * TODO: Determine whether we need to reset() the Keyboard sooner (ie, in the constructor),
         * or if we need to protect other methods from prematurely accessing certain Keyboard structures,
         * as a result of calls from any of the key event handlers established by setBinding().
         */
        if (this.abBuffer) {
            if (this.abBuffer.length < Keyboard.LIMIT.MAX_SCANCODES) {
                if (DESKPRO386) {
                    if (this.chipset && this.chipset.model == ChipSet.MODEL_COMPAQ_DESKPRO386) {
                        /*
                         * COMPAQ keyclick support is being disabled because we are currently unable to properly
                         * simulate the keyclick sound, due to the way the COMPAQ DeskPro 386 ROM rapidly toggles
                         * the speaker bit.  And there isn't really a better time to disable it, because the
                         * COMPAQ_KEYCLICK byte is set by IBMBIO.COM initialization code in COMPAQ MS-DOS, if the
                         * machine model byte is FC (indicating PC AT):
                         *
                         *      &0070:2EF7 2E               CS:
                         *      &0070:2EF8 803E442DFC       CMP      [2D44],FC
                         *      &0070:2EFD 750C             JNZ      2F0B (IBMBIO.COM+0x3174)
                         *      &0070:2EFF 26               ES:
                         *      &0070:2F00 C606160401       MOV      [0416],01
                         */
                        if (!this.cpu.isProtMode()) {
                            this.bus.setByteDirect(ROMX86.BIOS.COMPAQ_KEYCLICK, 0);
                        }
                    }
                }
                this.abBuffer.push(bScan);
                if (!COMPILED && this.messageEnabled()) this.printMessage("keyboard data " + Str.toHexByte(bScan) + " buffered");
                this.transmitData();
                return;
            }
            if (this.abBuffer.length == Keyboard.LIMIT.MAX_SCANCODES) {
                this.abBuffer.push(Keyboard.CMDRES.BUFF_FULL);
            }
            this.printMessage("keyboard buffer overflow");
        }
    }

    /**
     * injectInit(nCondition)
     *
     * @this {Keyboard}
     * @param {number} nCondition
     */
    injectInit(nCondition)
    {
        if (this.nInjection == nCondition) {
            this.nInjection = Keyboard.INJECTION.NONE;
            if (this.autoType) this.injectKeys(this.autoType);
        }
    }

    /**
     * injectKeys(sKeys, msDelay)
     *
     * @this {Keyboard}
     * @param {string} [sKeys]
     * @param {number} [msDelay] is an optional injection delay (default is msInjectDefault)
     * @return {boolean}
     */
    injectKeys(sKeys, msDelay)
    {
        if (sKeys) {
            let sInjectBuffer = this.parseKeys(sKeys);
            if (sInjectBuffer) {
                this.nInjection = Keyboard.INJECTION.NONE;
                this.sInjectBuffer = sInjectBuffer;
                if (!COMPILED) this.log("injectKeys(\"" + this.sInjectBuffer.split("\n").join("\\n") + "\")");
                this.msInjectDelay = msDelay || this.msInjectDefault;
                this.injectKeys();
                return true;
            }
            return false;
        }
        /*
         * Any delay of one second or more ($10 and up) is automatically reverted to the default.
         */
        if (this.msInjectDelay >= 1000) {
            this.msInjectDelay = this.msInjectDefault;
        }
        let simCode = 0;
        while (this.sInjectBuffer.length > 0 && !simCode) {
            let ch = this.sInjectBuffer.charAt(0);
            if (ch == '$') {
                /*
                 * $<number> pauses injection by the specified number of tenths of a second; eg,
                 * $5 pauses for 1/2 second.  $0 reverts the default injection delay (eg, 100ms).
                 * Also, you may end the number with a period if you need to avoid an injected digit
                 * being misinterpreted as part of the delay (eg, $5.1) pauses for 1/2 second and
                 * then injects "1").
                 */
                let digits = this.sInjectBuffer.match(/^\$([0-9]+)\.?/);
                if (digits) {
                    this.msInjectDelay = (+digits[1] * 100) || this.msInjectDefault;
                    this.sInjectBuffer = this.sInjectBuffer.substr(digits[0].length);
                    break;
                }
                /*
                 * Yes, this code is slow and gross, but it's simple, and key injection doesn't have
                 * to be that fast anyway.  The added check for SOFTCODES that have omitted the 'num-'
                 * prefix adds to the slowness, but it's a nice convenience, allowing you to specify
                 * non-ASCII keys like 'num-right' or 'num-up' more succinctly as  "$right" or "$up".
                 */
                for (let i = 0; i < this.softCodeKeys.length; i++) {
                    let name = this.softCodeKeys[i];
                    if (this.sInjectBuffer.indexOf(name) == 1) {
                        simCode = Keyboard.SOFTCODES[name];
                        this.sInjectBuffer = this.sInjectBuffer.substr(name.length + 1);
                        break;
                    }
                    let shortName = (name.indexOf('num-') == 0? name.substr(4) : "");
                    if (shortName && this.sInjectBuffer.indexOf(shortName) == 1) {
                        simCode = Keyboard.SOFTCODES[name];
                        this.sInjectBuffer = this.sInjectBuffer.substr(shortName.length + 1);
                        break;
                    }
                }
            }
            if (simCode) break;
            this.sInjectBuffer = this.sInjectBuffer.substr(1);
            let charCode = ch.charCodeAt(0);
            /*
             * charCodes 0x01-0x1A correspond to key combinations CTRL-A through CTRL-Z, unless they
             * are \t, \n, or \r, which are reserved for TAB, LINE-FEED, and RETURN, respectively, so if
             * you need to simulate CTRL-I, CTRL-J, or CTRL-M, those must be specified using \x1C, \x1D,
             * or \x1E, respectively.  Also, since PCs have no dedicated LINE-FEED key, and since \n is
             * often used instead of \r, we map LINE-FEED (LF) to RETURN (CR) below.
             */
            if (charCode <= Keys.ASCII.CTRL_Z) {
                simCode = charCode;
                /*
                 * I could require all callers to supply CRs instead of LFs, but this is friendlier; besides,
                 * PCs don't have a dedicated LINE-FEED key, so the LF charCode is somewhat meaningless.
                 */
                if (charCode == 0x0A) simCode = 0x0D;
                if (charCode != Keys.ASCII.CTRL_I && charCode != Keys.ASCII.CTRL_J && charCode != Keys.ASCII.CTRL_M) {
                    simCode += Keys.KEYCODE.FAKE;
                }
            }
            else if (charCode == 0x1C) {
                simCode = Keys.ASCII.CTRL_I + Keys.KEYCODE.FAKE;
            }
            else if (charCode == 0x1D) {
                simCode = Keys.ASCII.CTRL_J + Keys.KEYCODE.FAKE;
            }
            else if (charCode == 0x1E) {
                simCode = Keys.ASCII.CTRL_M + Keys.KEYCODE.FAKE;
            }
            else if (charCode == 0x1F) {
                simCode = Keys.ASCII['$'];
            }
            else if (charCode <= 0x7F) {
                simCode = charCode;
            }
        }

        if (simCode) {
            let fPress = (Keyboard.MODIFIERS[simCode] === undefined);
            this.addActiveKey(simCode, fPress);
            if (fPress) this.clearActiveKeys(true);
        }

        if (!this.sInjectBuffer.length) {
            if (this.fnInjectReady) {
                this.fnInjectReady();
                this.fnInjectReady = null;
            }
        } else {
            this.cpu.setTimer(this.timerInject, this.msInjectDelay);
        }
        return true;
    }

    /**
     * parseKeys(sKeys)
     *
     * The following special "macro" sequences are recognized:
     *
     *      $date:  converted to MM-DD-YYYY
     *      $time:  converted to HH:MM
     *
     * In addition, property keys in the SOFTCODES tables can be prefixed with "$" if you want to specify
     * a key by its SOFTCODE; eg:
     *
     *      $f1:    the F1 function key
     *      $alt:   the ALT key
     *
     * Not all SOFTCODES are allowed; for example, SOFTCODES that begin with a digit or other non-alpha symbol,
     * or that contain only one letter, because those SOFTCODES can already be specified as-is, WITHOUT a leading
     * "$".  Also, all we replace here are the "macro" sequences, leaving any prefixed SOFTCODES in place so that
     * injectKeys() can convert them on the fly.
     *
     * If you want any of those sequences to be typed as-is, then you must specify two "$" (eg, "$$date").
     * Pairs of dollar signs will be automatically converted to single dollar signs, and single dollar signs
     * will be used as-is, provided they don't precede any of the above "macro" or SOFTCODE sequences.
     *
     * WARNING: the JavaScript replace() function ALWAYS interprets "$" specially in replacement strings,
     * even when the search string is NOT a RegExp; specifically:
     *
     *      $$  Inserts a "$"
     *      $&  Inserts the matched substring
     *      $`  Inserts the portion of the string that precedes the matched substring
     *      $'  Inserts the portion of the string that follows the matched substring
     *      $n  Where n is a positive integer less than 100, inserts the nth parenthesized sub-match string,
     *          provided the first argument was a RegExp object
     *
     * Since we build machine definitions on a page from a potentially indeterminate number of string replace()
     * operations, multiple dollar signs could eventually get reduced to a single dollar sign BEFORE we get here.
     *
     * To compensate, I've changed a few replace() methods, like MarkOut's convertMDMachineLinks() and HTMLOut's
     * addFilesToHTML(), from the conventional string replace() to my own Str.replace(), and for situations like the
     * embed.js parseXML() function, which needs to use a RegExp-style replace(), I've added a preliminary
     * replace(/\$/g, "$$$$") to the replacement string.
     *
     * Unfortunately, this is something that will be extremely difficult to prevent from breaking down the road.
     * So, heads up to future me....
     *
     * @this {Keyboard}
     * @param {string|undefined} sKeys
     * @return {string|undefined}
     */
    parseKeys(sKeys)
    {
        if (sKeys) {
            let match, reSpecial = /(?:^|[^$])\$([a-z0-9][a-z0-9-]+)/g;
            while (match = reSpecial.exec(sKeys)) {
                let sReplace = "";
                switch (match[1]) {
                case 'date':
                    sReplace = Usr.formatDate("n-j-Y");
                    break;
                case 'time':
                    sReplace = Usr.formatDate("h:i:s");
                    break;
                default:
                    continue;
                }
                sKeys = sKeys.replace('$' + match[1], sReplace);
                /*
                 * Even though we did just modify the string that reSpecial is iterating over, we aren't
                 * going to muck with lastIndex, because 1) the replacement strings are always longer than
                 * original strings, and 2) any unrecognized sequences that we now leave in place would cause
                 * us to loop indefinitely.  So, if you really want to do this, you will have to carefully
                 * set lastIndex to the next unexamined character, not back to the beginning.
                 *
                 *      reSpecial.lastIndex = 0;
                 */
            }
            /*
             * Any lingering "$$" sequences are now converted to a special code (\x1F) that injectKeys() knows about.
             */
            sKeys = sKeys.replace(/\$\$/g, '\x1F');
        }
        return sKeys;
    }

    /**
     * waitReady(fnCallReady, sOption)
     *
     * @this {Keyboard}
     * @param {function()|null} fnCallReady
     * @param {string} [sOption]
     * @return {boolean} false if wait required, true otherwise
     */
    waitReady(fnCallReady, sOption)
    {
        let fReady = false;

        switch(sOption) {
        case "DOS":
            if (this.fDOSReady) {
                fReady = true;
            } else {
                this.fnDOSReady = fnCallReady;
            }
            break;

        default:
            if (!this.sInjectBuffer.length) {
                fReady = true;
            } else {
                this.fnInjectReady = fnCallReady;
            }
            break;
        }
        return fReady;
    }

    /**
     * setLED(control, f)
     *
     * @this {Keyboard}
     * @param {HTMLElement} control is an HTML control DOM object
     * @param {boolean} f is true if the LED represented by control should be "on", false if "off"
     */
    setLED(control, f)
    {
        /*
         * TODO: Add support for user-definable LED colors
         */
        control.style.backgroundColor = (f? "#00ff00" : "#000000");
    }

    /**
     * updateLEDs(bitState)
     *
     * Updates any and all shift-related LEDs with the corresponding state in bitsStateSim.
     *
     * @this {Keyboard}
     * @param {number} [bitState] is the bit in bitsStateSim that may have changed, if known; undefined if not
     */
    updateLEDs(bitState)
    {
        let control;
        for (let sBinding in Keyboard.LEDSTATES) {
            let id = "led-" + sBinding;
            let bitLED = Keyboard.LEDSTATES[sBinding];
            if ((!bitState || bitState == bitLED) && (control = this.bindings[id])) {
                this.setLED(control, !!(this.bitsStateSim & bitLED));
            }
        }
    }

    /**
     * toggleCapsLock()
     *
     * @this {Keyboard}
     */
    toggleCapsLock()
    {
        this.addActiveKey(Keyboard.SIMCODE.CAPS_LOCK, true);
    }

    /**
     * toggleNumLock()
     *
     * @this {Keyboard}
     */
    toggleNumLock()
    {
        this.addActiveKey(Keyboard.SIMCODE.NUM_LOCK, true);
    }

    /**
     * toggleScrollLock()
     *
     * @this {Keyboard}
     */
    toggleScrollLock()
    {
        this.addActiveKey(Keyboard.SIMCODE.SCROLL_LOCK, true);
    }

    /**
     * updateShiftState(simCode, fSim, fDown)
     *
     * For non-locking shift keys, this function is straightforward: when fDown is true, the corresponding bitState
     * is set, and when fDown is false, it's cleared.  However, for LOCK keys, fDown true means toggle, and fDown false
     * means no change.
     *
     * @this {Keyboard}
     * @param {number} simCode (includes any ONDOWN and/or ONRIGHT modifiers)
     * @param {boolean} [fSim] is true to update simulated state only
     * @param {boolean|null} [fDown] is true for down, false for up, undefined for toggle
     * @return {number} 0 if not a shift key, 1 if shift key down, -1 if shift key up
     */
    updateShiftState(simCode, fSim, fDown)
    {
        let result = 0;
        if (Keyboard.SIMCODES[simCode]) {
            let fRight = (Math.floor(simCode / 1000) & 2);
            let bitState = Keyboard.KEYSTATES[simCode] || 0;
            if (bitState) {
                if (fRight && !(bitState & Keyboard.STATE.ALL_RIGHT)) {
                    bitState >>= 1;
                }
                if (bitState & Keyboard.STATE.ALL_LOCKS) {
                    if (fDown === false) return -1;
                    fDown = null;
                }
                if (fDown == null) {        // ie, null or undefined
                    fDown = !((fSim? this.bitsStateSim : this.bitsState) & bitState);
                }
                else if (!fDown && !fSim) {
                    /*
                     * In current webkit browsers, pressing and then releasing both left and right shift keys together
                     * (or both ALT keys, or both CMD/Windows keys, or presumably both CTRL keys) results in 4 events,
                     * as you would expect, but 3 of the 4 are "down" events; only the last of the 4 is an "up" event.
                     *
                     * Perhaps this is a browser accessibility feature (ie, deliberately suppressing the "up" event
                     * of one of the shift keys to implement a "sticky shift mode"?), but in any case, to maintain our
                     * internal consistency, if this is an "up" event and the shift state bit is any of ALL_MODIFIERS,
                     * then we set it to ALL_MODIFIERS, so that we'll automatically clear ALL shift states.
                     *
                     * TODO: The only downside to this work-around is that the simulation will still think a shift key is
                     * down.  So in effect, we have enabled a "sticky shift mode" inside the simulation, whether or not that
                     * was the browser's intent.  To fix that, we would have to identify the shift key that never went up
                     * and simulate the "up".  That's more work than I think the problem merits.  The user just needs to tap
                     * a single shift key to get out that mode.
                     */
                    if (bitState & Keyboard.STATE.ALL_MODIFIERS) bitState = Keyboard.STATE.ALL_MODIFIERS;
                }
                if (!fSim) {
                    this.bitsState &= ~bitState;
                    if (fDown) this.bitsState |= bitState;
                } else {
                    /*
                     * This next line reflects the fact that we don't want to modify any simulated LOCK states if a simulated
                     * shift state (ie, CTRL, ALT, SHIFT, etc) is also active.  For example, CTRL-NUM-LOCK is a special sequence
                     * (Pause) that isn't supposed to alter the NUM-LOCK state; similarly, CTRL-SCROLL-LOCK (aka Ctrl-Break)
                     * isn't supposed to alter the SCROLL-LOCK state.
                     */
                    if (!(this.bitsStateSim & Keyboard.STATE.ALL_MODIFIERS) || !(bitState & Keyboard.STATE.ALL_LOCKS)) {
                        this.bitsStateSim &= ~bitState;
                        if (fDown) this.bitsStateSim |= bitState;
                        this.updateLEDs(bitState);
                    }
                }
                result = fDown? 1 : -1;
            }
        }
        return result;
    }

    /**
     * addActiveKey(simCode, fPress)
     *
     * @this {Keyboard}
     * @param {number} simCode
     * @param {boolean} [fPress]
     * @return {boolean} true if added, false if not (eg, not recognized, already added, etc)
     */
    addActiveKey(simCode, fPress)
    {
        let wCode = Keyboard.SIMCODES[simCode] || Keyboard.SIMCODES[simCode += Keys.KEYCODE.ONDOWN];

        if (!wCode) {
            if (!COMPILED && this.messageEnabled(Messages.KBD | Messages.KEY)) {
                this.printMessage("addActiveKey(" + simCode + "," + (fPress? "press" : "down") + "): unrecognized", true);
            }
            return false;
        }

        /*
         * Ignore all active keys if the CPU is not running.
         */
        if (!this.cpu || !this.cpu.isRunning()) return false;

        /*
         * If this simCode is in the KEYSTATE table, then stop all repeating.
         */
        if (Keyboard.KEYSTATES[simCode] && this.aKeysActive.length) {
            if (this.aKeysActive[0].nRepeat > 0) this.aKeysActive[0].nRepeat = 0;
        }

        let i, key;
        for (i = 0; i < this.aKeysActive.length; i++) {
            key = this.aKeysActive[i];
            if (key.simCode == simCode) {
                /*
                 * This key is already active, so if this a "down" request (or a "press" for a key we already
                 * processed as a "down"), ignore it.
                 */
                if (!fPress || key.nRepeat >= 0) {
                    i = -1;
                    break;
                }
                if (i > 0) {
                    if (this.aKeysActive[0].nRepeat > 0) this.aKeysActive[0].nRepeat = 0;
                    this.aKeysActive.splice(i, 1);
                }
                break;
            }
        }

        if (!COMPILED && this.messageEnabled(Messages.KBD | Messages.KEY)) {
            this.printMessage("addActiveKey(" + simCode + "," + (fPress? "press" : "down") + "): " + (i < 0? "already active" : (i == this.aKeysActive.length? "adding" : "updating")), true);
        }

        if (i < 0) return false;

        if (i == this.aKeysActive.length) {
            key = {simCode};                            // create a new Key object
            // key.bitsState = this.bitsState;          // not needed unless we revive checkActiveKeyShift()
            this.findBinding(simCode, "key", true);
            i++;
        }

        if (i > 0) {
            this.aKeysActive.splice(0, 0, key);         // aka aKeysActive.unshift(key)
        }

        key.fDown = true;
        key.nRepeat = (fPress? -1: (Keyboard.KEYSTATES[simCode]? 0 : 1));

        this.updateActiveKey(key);
        return true;
    }

    /**
     * checkActiveKey()
     *
     * @this {Keyboard}
     * @return {number} simCode of active key, 0 if none
     */
    checkActiveKey()
    {
        return this.aKeysActive.length? this.aKeysActive[0].simCode : 0;
    }

    /**
     * isAlphaKey(code)
     *
     * @this {Keyboard}
     * @param {number} code
     * @returns {boolean} true if alpha key, false if not
     */
    isAlphaKey(code)
    {
        return (code >= Keys.ASCII.A && code <= Keys.ASCII.Z || code >= Keys.ASCII.a && code <= Keys.ASCII.z);
    }

    /**
     * toUpperKey(code)
     *
     * @this {Keyboard}
     * @param {number} code
     * @returns {number}
     */
    toUpperKey(code)
    {
        if (code >= Keys.ASCII.a && code <= Keys.ASCII.z) {
            code -= (Keys.ASCII.a - Keys.ASCII.A);
        }
        return code;
    }

    /**
     * clearActiveKeys(fModifiers)
     *
     * Force all active keys to "deactivate" (or, optionally, just any modifiers)
     *
     * @this {Keyboard}
     * @param {boolean} [fModifiers] (true to clear modifier keys only; default is ALL keys)
     */
    clearActiveKeys(fModifiers)
    {
        for (let i = 0; i < this.aKeysActive.length; i++) {
            let key = this.aKeysActive[i];
            if (fModifiers && !Keyboard.MODIFIERS[key.simCode]) continue;
            if (this.removeActiveKey(key.simCode)) i--;
        }
    }

    /**
     * removeActiveKey(simCode, fFlush)
     *
     * @param {number} simCode
     * @param {boolean} [fFlush] is true whenever the key must be removed, independent of other factors
     * @return {boolean} true if successfully removed, false if not
     */
    removeActiveKey(simCode, fFlush)
    {
        if (!Keyboard.SIMCODES[simCode]) {
            if (!COMPILED && this.messageEnabled(Messages.KBD | Messages.KEY)) {
                this.printMessage("removeActiveKey(" + simCode + "): unrecognized", true);
            }
            return false;
        }

        /*
         * Ignore all active keys if the CPU is not running.
         */
        if (!fFlush && (!this.cpu || !this.cpu.isRunning())) return false;

        let fRemoved = false;
        for (let i = 0; i < this.aKeysActive.length; i++) {
            let key = this.aKeysActive[i];
            if (key.simCode == simCode || key.simCode == Keys.SHIFTED_KEYCODES[simCode]) {
                this.aKeysActive.splice(i, 1);
                if (key.timer) clearTimeout(key.timer);
                if (key.fDown && !fFlush) this.keySimulate(key.simCode, false);
                this.findBinding(simCode, "key", false);
                fRemoved = true;
                break;
            }
        }
        if (!COMPILED && !fFlush && this.messageEnabled(Messages.KBD | Messages.KEY)) {
            this.printMessage("removeActiveKey(" + simCode + "): " + (fRemoved? "removed" : "not active"), true);
        }
        if (!this.aKeysActive.length && this.fToggleCapsLock) {
            if (!COMPILED) this.printMessage("removeActiveKey(): inverting caps-lock now", Messages.KBD | Messages.KEY);
            this.updateShiftState(Keyboard.SIMCODE.CAPS_LOCK);
            this.fToggleCapsLock = false;
        }
        return fRemoved;
    }

    /**
     * updateActiveKey(key, msTimer)
     *
     * When called by addActiveKey(), msTimer is undefined; that's used only when we're called by our own timeout handler.
     *
     * @param {Object} key
     * @param {number} [msTimer]
     */
    updateActiveKey(key, msTimer)
    {
        /*
         * All active keys are automatically removed once the CPU stops running.
         */
        if (!this.cpu || !this.cpu.isRunning()) {
            this.removeActiveKey(key.simCode, true);
            return;
        }

        if (!COMPILED && this.messageEnabled(Messages.KBD | Messages.KEY)) {
            this.printMessage("updateActiveKey(" + key.simCode + (msTimer? "," + msTimer + "ms" : "") + "): " + (key.fDown? "down" : "up"), true);
        }

        if (msTimer && key.nRepeat < 0) {
            key.fDown = false;
        }

        if (!this.keySimulate(key.simCode, key.fDown) || !key.nRepeat) {
            /*
             * Why isn't there a simple return here? In order to set breakpoints on two different return conditions, of course!
             */
            if (!msTimer) {
                return;
            }
            return;
        }

        let ms;
        if (key.nRepeat < 0) {
            if (!key.fDown) {
                this.removeActiveKey(key.simCode);
                return;
            }
            ms = this.msAutoRelease;
        }
        else {
            ms = (key.nRepeat++ == 1? this.msAutoRepeat : this.msNextRepeat);
        }

        if (key.timer) {
            clearTimeout(key.timer);
        }

        key.timer = setTimeout(function(kbd) {
            return function onUpdateActiveKey() {
                kbd.updateActiveKey(key, ms);
            };
        }(this), ms);
    }

    /**
     * getSimCode(keyCode)
     *
     * @this {Keyboard}
     * @param {number} keyCode
     * @param {boolean} fShifted
     * @return {number} simCode
     */
    getSimCode(keyCode, fShifted)
    {
        let code;
        let simCode = keyCode;

        if (keyCode >= Keys.ASCII.A && keyCode <= Keys.ASCII.Z) {
            if (!(this.bitsState & (Keyboard.STATE.SHIFT | Keyboard.STATE.RSHIFT | Keyboard.STATE.CAPS_LOCK)) == fShifted) {
                simCode = keyCode + (Keys.ASCII.a - Keys.ASCII.A);
            }
        }
        else if (keyCode >= Keys.ASCII.a && keyCode <= Keys.ASCII.z) {
            if (!!(this.bitsState & (Keyboard.STATE.SHIFT | Keyboard.STATE.RSHIFT | Keyboard.STATE.CAPS_LOCK)) == fShifted) {
                simCode = keyCode - (Keys.ASCII.a - Keys.ASCII.A);
            }
        }
        else if (!!(this.bitsState & (Keyboard.STATE.SHIFT | Keyboard.STATE.RSHIFT)) == fShifted) {
            if (code = Keys.SHIFTED_KEYCODES[keyCode]) {
                simCode = code;
            }
        }
        else {
            if (code = Keys.NONASCII_KEYCODES[keyCode]) {
                simCode = code;
            }
        }
        return simCode;
    }

    /**
     * onFocusChange(fFocus)
     *
     * @this {Keyboard}
     * @param {boolean} fFocus is true if gaining focus, false if losing it
     */
    onFocusChange(fFocus)
    {
        if (!COMPILED && this.fHasFocus != fFocus && this.messageEnabled(Messages.EVENT)) {
            this.printMessage("onFocusChange(" + (fFocus? "true" : "false") + ")", true);
        }
        this.fHasFocus = fFocus;
        /*
         * Since we can't be sure of any shift states after losing focus, we clear them all.
         */
        if (!fFocus) {
            this.bitsState &= ~Keyboard.STATE.ALL_MODIFIERS;
            this.clearActiveKeys(true);
        }
    }

    /**
     * onKeyChange(event, fDown)
     *
     * @this {Keyboard}
     * @param {Object} event
     * @param {boolean} fDown is true for a keyDown event, false for a keyUp event
     * @return {boolean} true to pass the event along, false to consume it
     */
    onKeyChange(event, fDown)
    {
        let fPass = true;
        let fPress = false;
        let fIgnore = false;
        let keyCode = event.keyCode;

        if (!this.cmp.notifyKbdEvent(event, fDown)) {
            return false;
        }

        if (fDown) this.cKeysPressed++;
        this.sInjectBuffer = "";                        // actual key events should stop any injection in progress
        Component.processScript(this.idMachine);        // and any script, too

        /*
         * Although it would be nice to pay attention ONLY to these "up" and "down" events, and ignore "press"
         * events, iOS devices force us to process "press" events, because they don't give us shift-key events,
         * so we have to infer the shift state from the character code in the "press" event.
         *
         * So, to seamlessly blend "up" and "down" events with "press" events, we must convert any keyCodes we
         * receive here to a compatibly shifted simCode.
         */
        let simCode = this.getSimCode(keyCode, true);

        if (this.fEscapeDisabled && simCode == Keys.ASCII['`']) {
            keyCode = simCode = Keys.KEYCODE.ESC;
        }

        if (Keyboard.SIMCODES[keyCode + Keys.KEYCODE.ONDOWN]) {

            simCode += Keys.KEYCODE.ONDOWN;
            if (event.location == Keys.LOCATION.RIGHT) {
                simCode += Keys.KEYCODE.ONRIGHT;
            }

            let nShiftState = this.updateShiftState(simCode, false, fDown);
            if (nShiftState) {

                if (keyCode == Keys.KEYCODE.CAPS_LOCK || keyCode == Keys.KEYCODE.NUM_LOCK || keyCode == Keys.KEYCODE.SCROLL_LOCK) {
                    /*
                     * FYI, "lock" keys generate a DOWN event ONLY when getting locked and an UP event ONLY
                     * when getting unlocked--which is a little odd, since the key did go UP and DOWN each time.
                     *
                     * We must treat each event like a "down", and also as a "press", so that addActiveKey() will
                     * automatically generate both the "make" and "break".
                     *
                     * Of course, there have to be exceptions, most notably both Microsoft Internet Explorer and Edge
                     * (and, apparently, pretty much any other browser running on the Windows platform), which send both
                     * UP and DOWN events on every press, so there's no need for this trickery.
                     */
                    if (!this.fMSWindows) {
                        fDown = fPress = true;
                    }
                }

                /*
                 * HACK for Windows (as the host operating system): the ALT key is often used with key combinations
                 * not meant for our machine (eg, Alt-Tab to switch to a different window, or simply tapping the ALT
                 * key by itself to switch focus to the browser's menubar).  And sadly, browsers are quite happy to
                 * give us the DOWN event for the ALT key, but not an UP event, leaving our machine with the impression
                 * that the ALT key is still down, which the user user has no easy way to detect OR correct.
                 *
                 * So we still record the ALT state in bitsState as best we can, and clear it whenever we lose focus
                 * in onFocusChange(), but we no longer pass through DOWN events to our machine.  Instead, we now
                 * check bitsState prior to simulating any other key, and if the ALT bit is set, we simulate an
                 * active ALT key first; you'll find that check at the end of both onKeyChange() and onKeyPress().
                 *
                 * NOTE: Even though this is a hack intended largely for browsers running on Windows, I'm implementing
                 * it for all platforms, for consistency.
                 */
                if (keyCode == Keys.KEYCODE.ALT) {
                    if (fDown) {
                        /*
                         * One exception to this hack is the "Sidekick" exception: if the CTRL key is also down,
                         * we'll still simulate ALT immediately, for those users who press CTRL and then ALT to pop up
                         * Sidekick (as opposed to pressing ALT and then CTRL, which should also work, regardless).
                         */
                        if (!(this.bitsState & Keyboard.STATE.CTRL)) fIgnore = true;
                        /*
                         * Reset cKeysPressed so that we can detect the mere "tapping" of the ALT key, which some PCjs
                         * demos depend on (eg, Multi-tasking MS-DOS 4.0).
                         */
                        this.cKeysPressed = 0;
                    }
                    else {
                        if (!this.cKeysPressed) {
                            /*
                             * Since cKeysPressed is zero, the assumption here is that the ALT key (and the Alt key ALONE)
                             * was just tapped, so as long the ALT key was not already "soft-locked" (based on bitsStateSim),
                             * we will transform this "up" event into a "fake press" event.
                             */
                            if (!(this.bitsStateSim & (Keyboard.STATE.ALT | Keyboard.STATE.RALT))) {
                                fDown = fPress = true;
                            }
                        }
                    }
                }

                /*
                 * As a safeguard, whenever the CMD key goes up, clear all active keys, because there appear to be
                 * cases where we don't always get notification of a CMD key's companion key going up (this probably
                 * overlaps with most if not all situations where we also lose focus).
                 */
                if (!fDown && (keyCode == Keys.KEYCODE.CMD || keyCode == Keys.KEYCODE.RCMD)) {
                    this.clearActiveKeys();
                }
            }
            else {
                /*
                 * Here we have all the non-shift keys in the ONDOWN category; eg, BS, TAB, ESC, UP, DOWN, LEFT, RIGHT,
                 * and many more.
                 *
                 * For various reasons (some of which are discussed below), we don't want to pass these on (ie, we want
                 * to suppress their "press" event), which means we must perform all key simulation on the "up" and "down"
                 * events.
                 *
                 * Regarding BS: I never want the browser to act on BS, since it does double-duty as the BACK button,
                 * leaving the current page.
                 *
                 * Regarding TAB: If I don't consume TAB on the "down" event, then that's all I'll see, because the browser
                 * acts on it by giving focus to the next control.
                 *
                 * Regarding ESC: This key generates "down" and "up" events (LOTS of "down" events for that matter), but no
                 * "press" event.
                 */

                /*
                 * HACKs for mapping CTRL-BACKSPACE and CTRL-ALT-BACKSPACE to CTRL-BREAK and CTRL-ALT-DEL, respectively.
                 */
                if (keyCode == Keys.KEYCODE.BS && (this.bitsState & (Keyboard.STATE.CTRL|Keyboard.STATE.ALT)) == Keyboard.STATE.CTRL) {
                    simCode = Keyboard.SIMCODE.CTRL_BREAK;
                }
                if (keyCode == Keys.KEYCODE.BS && (this.bitsState & (Keyboard.STATE.CTRL|Keyboard.STATE.ALT)) == (Keyboard.STATE.CTRL|Keyboard.STATE.ALT)) {
                    simCode = Keyboard.SIMCODE.CTRL_ALT_DEL;
                }

                /*
                 * There are a number of other common key sequences that interfere with our machines; for example,
                 * the up/down arrows have a "default" behavior of scrolling the web page up and down, which is
                 * definitely NOT a behavior we want.  Since we mark those keys as ONDOWN, we'll catch them all here.
                 */
                fPass = false;
            }
        }
        else {
            /*
             * HACKs for mapping assorted CTRL-ALT sequences involving "normal" keys (eg, PERIOD, EQUALS, and DASH).
             */
            if ((this.bitsState & (Keyboard.STATE.CTRL|Keyboard.STATE.ALT)) == (Keyboard.STATE.CTRL|Keyboard.STATE.ALT)) {
                if (keyCode == Keys.KEYCODE.PERIOD) {
                    simCode = Keyboard.SIMCODE.CTRL_ALT_DEL;    // in case your operating system won't let you type CTRL-ALT-BACKSPACE either
                }
                if (keyCode == Keys.KEYCODE.EQUALS) {
                    simCode = Keyboard.SIMCODE.CTRL_ALT_ADD;    // in case your keyboard doesn't have a numeric keypad '+'
                }
                else if (keyCode == Keys.KEYCODE.DASH) {
                    simCode = Keyboard.SIMCODE.CTRL_ALT_SUB;    // in case your keyboard doesn't have a numeric keypad '-'
                }
            }

            /*
             * When I have defined system-wide CTRL-key sequences to perform common editing operations (eg, CTRL_W
             * and CTRL_Z to scroll pages of text), the browser likes to act on those operations, so let's set fPass
             * to false to prevent that.
             *
             * Also, we don't want to set fIgnore in such cases, because the browser may not give us a press event for
             * these CTRL-key sequences, so we can't risk ignoring them.
             */
            if (Keyboard.SIMCODES[simCode] && (this.bitsState & (Keyboard.STATE.CTRLS | Keyboard.STATE.ALTS))) {
                fPass = false;
            }

            /*
             * Don't simulate any key not explicitly marked ONDOWN, as well as any key sequence with the CMD key held.
             */
            if (!this.fAllDown && fPass && fDown || (this.bitsState & Keyboard.STATE.CMDS)) {
                fIgnore = true;
            }
        }

        if (!fPass) {
            event.preventDefault();
        }

        if (this.messageEnabled(Messages.EVENT | Messages.KEY)) {
            this.printMessage("onKeyChange(" + keyCode + "): " + (fDown? "down" : "up") + (fIgnore? ",ignore" : (fPass? "" : ",consume")), true);
        }

        /*
         * Mobile (eg, iOS) keyboards don't fully support onkeydown/onkeyup events; for example, they usually
         * don't generate ANY events when a shift key is pressed, and even for normal keys, they seem to generate
         * rapid (ie, fake) "up" and "down" events around "press" events, probably more to satisfy compatibility
         * issues rather than making a serious effort to indicate when a key ACTUALLY went down or up.
         */
        if (!fIgnore && (!this.fMobile || !fPass)) {
            if (fDown) {
                /*
                 * This is the companion code to the onKeyChange() hack for Windows that suppresses DOWN events
                 * for ALT keys: if we're about to activate another key and we believe that an ALT key is still down,
                 * we fake an ALT activation first.
                 */
                if (this.bitsState & Keyboard.STATE.ALTS) {
                    let simCodeAlt = Keyboard.SIMCODE.ALT;
                    this.printMessage("onKeyChange(" + simCodeAlt + "): simulating ALT down", Messages.EVENT);
                    this.addActiveKey(simCodeAlt);
                }
                this.addActiveKey(simCode, fPress);
            } else {
                if (!this.removeActiveKey(simCode)) {
                    let code = this.getSimCode(keyCode, false);
                    if (code != simCode) this.removeActiveKey(code);
                }
            }
        }

        return fPass;
    }

    /**
     * onKeyPress(event)
     *
     * @this {Keyboard}
     * @param {Object} event
     * @return {boolean} true to pass the event along, false to consume it
     */
    onKeyPress(event)
    {
        event = event || window.event;
        let keyCode = event.which || event.keyCode;

        if (!this.cmp.notifyKbdEvent(event)) {
            return false;
        }

        this.cKeysPressed++;
        this.sInjectBuffer = "";        // actual key events should stop any injection currently in progress

        if (this.fAllDown) {
            let simCode = this.checkActiveKey();
            if (simCode && this.isAlphaKey(simCode) && this.isAlphaKey(keyCode) && simCode != keyCode) {
                if (!COMPILED && this.messageEnabled(Messages.EVENT | Messages.KEY)) {
                    this.printMessage("onKeyPress(" + keyCode + ") out of sync with " + simCode + ", invert caps-lock", true);
                }
                this.fToggleCapsLock = true;
                keyCode = simCode;
            }
        }

        let fPass = !Keyboard.SIMCODES[keyCode] || !!(this.bitsState & Keyboard.STATE.CMD);

        if (this.messageEnabled(Messages.EVENT | Messages.KEY)) {
            this.printMessage("onKeyPress(" + keyCode + "): " + (fPass? "true" : "false"), true);
        }

        if (!fPass) {
            /*
             * This is the companion code to the onKeyChange() hack for Windows that suppresses DOWN events
             * for ALT keys: if we're about to activate another key and we believe that an ALT key is still down,
             * we fake an ALT activation first.
             */
            if (this.bitsState & Keyboard.STATE.ALTS) {
                let simCodeAlt = Keyboard.SIMCODE.ALT;
                this.printMessage("onKeyPress(" + simCodeAlt + "): simulating ALT down", Messages.EVENT);
                this.addActiveKey(simCodeAlt);
            }
            this.addActiveKey(keyCode, true);
        }

        return fPass;
    }

    /**
     * keySimulate(simCode, fDown)
     *
     * @this {Keyboard}
     * @param {number} simCode
     * @param {boolean} fDown
     * @return {boolean} true if successfully simulated, false if unrecognized/unsupported key
     */
    keySimulate(simCode, fDown)
    {
        let fSimulated = false;

        this.updateShiftState(simCode, true, fDown);

        let wCode = Keyboard.SIMCODES[simCode] || Keyboard.SIMCODES[simCode + Keys.KEYCODE.ONDOWN];

        if (wCode !== undefined) {

            let abScanCodes = [];
            let bCode = wCode & 0xff;

            /*
             * TODO: Update the following restrictions to address 84-key and 101-key keyboard limitations.
             */
            if (bCode > 83 && this.modelKeys == 83) {
                return false;
            }

            abScanCodes.push(bCode | (fDown? 0 : Keyboard.SCANCODE.BREAK));

            let fAlpha = (simCode >= Keys.ASCII.A && simCode <= Keys.ASCII.Z || simCode >= Keys.ASCII.a && simCode <= Keys.ASCII.z);

            while (wCode >>>= 8) {
                let bShift = 0;
                let bScan = wCode & 0xff;
                /*
                 * TODO: The handling of SIMCODE entries with "extended" codes still needs to be tested, and
                 * moreover, if any of them need to perform any shift-state modifications, those modifications
                 * may need to be encoded differently.
                 */
                if (bCode == Keyboard.SCANCODE.EXTEND1 || bCode == Keyboard.SCANCODE.EXTEND2) {
                    abScanCodes.push(bCode | (fDown? 0 : Keyboard.SCANCODE.BREAK));
                    continue;
                }
                if (bScan == Keyboard.SCANCODE.SHIFT) {
                    if (!(this.bitsStateSim & (Keyboard.STATE.SHIFT | Keyboard.STATE.RSHIFT))) {
                        if (!(this.bitsStateSim & Keyboard.STATE.CAPS_LOCK) || !fAlpha) {
                            bShift = bScan;
                        }
                    }
                } else if (bScan == Keyboard.SCANCODE.CTRL) {
                    if (!(this.bitsStateSim & (Keyboard.STATE.CTRL | Keyboard.STATE.RCTRL))) {
                        bShift = bScan;
                    }
                } else if (bScan == Keyboard.SCANCODE.ALT) {
                    if (!(this.bitsStateSim & (Keyboard.STATE.ALT | Keyboard.STATE.RALT))) {
                        bShift = bScan;
                    }
                } else {
                    abScanCodes.push(bCode | (fDown? 0 : Keyboard.SCANCODE.BREAK));

                }
                if (bShift) {
                    if (fDown)
                        abScanCodes.unshift(bShift);
                    else
                        abScanCodes.push(bShift | Keyboard.SCANCODE.BREAK);
                }
            }

            for (let i = 0; i < abScanCodes.length; i++) {
                this.addScanCode(abScanCodes[i]);
            }

            fSimulated = true;
        }

        if (!COMPILED && this.messageEnabled(Messages.KBD | Messages.KEY)) {
            this.printMessage("keySimulate(" + simCode + "," + (fDown? "down" : "up") + "): " + (fSimulated? "true" : "false"), true);
        }

        return fSimulated;
    }

    /**
     * checkActiveKeyShift()
     *
     * @this {Keyboard}
     * @return {number|null} bitsState for active key, null if none
     *
     checkActiveKeyShift()
     {
         return this.aKeysActive.length? this.aKeysActive[0].bitsState : null;
     }
     */

    /**
     * Keyboard.init()
     *
     * This function operates on every HTML element of class "keyboard", extracting the
     * JSON-encoded parameters for the Keyboard constructor from the element's "data-value"
     * attribute, invoking the constructor to create a Keyboard component, and then binding
     * any associated HTML controls to the new component.
     */
    static init()
    {
        let aeKbd = Component.getElementsByClass(document, PCX86.APPCLASS, "keyboard");
        for (let iKbd = 0; iKbd < aeKbd.length; iKbd++) {
            let eKbd = aeKbd[iKbd];
            let parmsKbd = Component.getComponentParms(eKbd);
            let kbd = new Keyboard(parmsKbd);
            Component.bindComponentControls(kbd, eKbd, PCX86.APPCLASS);
        }
    }
}

/*
 * Supported keyboard models (the first entry is the default if the specified model isn't recognized)
 */
Keyboard.MODELS = ["US83", "US84", "US101"];

Keyboard.SIMCODE = {
    BS:             Keys.KEYCODE.BS          + Keys.KEYCODE.ONDOWN,
    TAB:            Keys.KEYCODE.TAB         + Keys.KEYCODE.ONDOWN,
    SHIFT:          Keys.KEYCODE.SHIFT       + Keys.KEYCODE.ONDOWN,
    RSHIFT:         Keys.KEYCODE.SHIFT       + Keys.KEYCODE.ONDOWN + Keys.KEYCODE.ONRIGHT,
    CTRL:           Keys.KEYCODE.CTRL        + Keys.KEYCODE.ONDOWN,
    ALT:            Keys.KEYCODE.ALT         + Keys.KEYCODE.ONDOWN,
    RALT:           Keys.KEYCODE.ALT         + Keys.KEYCODE.ONDOWN + Keys.KEYCODE.ONRIGHT,
    CAPS_LOCK:      Keys.KEYCODE.CAPS_LOCK   + Keys.KEYCODE.ONDOWN,
    ESC:            Keys.KEYCODE.ESC         + Keys.KEYCODE.ONDOWN,
    /*
     * It seems that a recent change to Safari on iOS (first noticed in iOS 9.1) treats SPACE
     * differently now, at least with regard to <textarea> controls, and possibly only readonly
     * or hidden controls, like the hidden <textarea> we overlay on the Video <canvas> element.
     *
     * Whatever the exact criteria are, Safari on iOS now performs SPACE's default behavior
     * after the onkeydown event but before the onkeypress event.  So we must now process SPACE
     * as an ONDOWN key, so that we can call preventDefault() and properly simulate the key at
     * the time the key goes down.
     */
    SPACE:          Keys.KEYCODE.SPACE       + Keys.KEYCODE.ONDOWN,
    F1:             Keys.KEYCODE.F1          + Keys.KEYCODE.ONDOWN,
    F2:             Keys.KEYCODE.F2          + Keys.KEYCODE.ONDOWN,
    F3:             Keys.KEYCODE.F3          + Keys.KEYCODE.ONDOWN,
    F4:             Keys.KEYCODE.F4          + Keys.KEYCODE.ONDOWN,
    F5:             Keys.KEYCODE.F5          + Keys.KEYCODE.ONDOWN,
    F6:             Keys.KEYCODE.F6          + Keys.KEYCODE.ONDOWN,
    F7:             Keys.KEYCODE.F7          + Keys.KEYCODE.ONDOWN,
    F8:             Keys.KEYCODE.F8          + Keys.KEYCODE.ONDOWN,
    F9:             Keys.KEYCODE.F9          + Keys.KEYCODE.ONDOWN,
    F10:            Keys.KEYCODE.F10         + Keys.KEYCODE.ONDOWN,
    F11:            Keys.KEYCODE.F11         + Keys.KEYCODE.ONDOWN,
    F12:            Keys.KEYCODE.F12         + Keys.KEYCODE.ONDOWN,
    NUM_LOCK:       Keys.KEYCODE.NUM_LOCK    + Keys.KEYCODE.ONDOWN,
    SCROLL_LOCK:    Keys.KEYCODE.SCROLL_LOCK + Keys.KEYCODE.ONDOWN,
    PRTSC:          Keys.KEYCODE.PRTSC       + Keys.KEYCODE.ONDOWN,
    HOME:           Keys.KEYCODE.HOME        + Keys.KEYCODE.ONDOWN,
    UP:             Keys.KEYCODE.UP          + Keys.KEYCODE.ONDOWN,
    PGUP:           Keys.KEYCODE.PGUP        + Keys.KEYCODE.ONDOWN,
    LEFT:           Keys.KEYCODE.LEFT        + Keys.KEYCODE.ONDOWN,
    NUM_INS:        Keys.KEYCODE.NUM_INS     + Keys.KEYCODE.ONDOWN,
    NUM_END:        Keys.KEYCODE.NUM_END     + Keys.KEYCODE.ONDOWN,
    NUM_DOWN:       Keys.KEYCODE.NUM_DOWN    + Keys.KEYCODE.ONDOWN,
    NUM_PGDN:       Keys.KEYCODE.NUM_PGDN    + Keys.KEYCODE.ONDOWN,
    NUM_LEFT:       Keys.KEYCODE.NUM_LEFT    + Keys.KEYCODE.ONDOWN,
    NUM_CENTER:     Keys.KEYCODE.NUM_CENTER  + Keys.KEYCODE.ONDOWN,
    NUM_RIGHT:      Keys.KEYCODE.NUM_RIGHT   + Keys.KEYCODE.ONDOWN,
    NUM_HOME:       Keys.KEYCODE.NUM_HOME    + Keys.KEYCODE.ONDOWN,
    NUM_UP:         Keys.KEYCODE.NUM_UP      + Keys.KEYCODE.ONDOWN,
    NUM_PGUP:       Keys.KEYCODE.NUM_PGUP    + Keys.KEYCODE.ONDOWN,
    NUM_ADD:        Keys.KEYCODE.NUM_ADD     + Keys.KEYCODE.ONDOWN,
    NUM_SUB:        Keys.KEYCODE.NUM_SUB     + Keys.KEYCODE.ONDOWN,
    NUM_DEL:        Keys.KEYCODE.NUM_DEL     + Keys.KEYCODE.ONDOWN,
    RIGHT:          Keys.KEYCODE.RIGHT       + Keys.KEYCODE.ONDOWN,
    END:            Keys.KEYCODE.END         + Keys.KEYCODE.ONDOWN,
    DOWN:           Keys.KEYCODE.DOWN        + Keys.KEYCODE.ONDOWN,
    PGDN:           Keys.KEYCODE.PGDN        + Keys.KEYCODE.ONDOWN,
    INS:            Keys.KEYCODE.INS         + Keys.KEYCODE.ONDOWN,
    DEL:            Keys.KEYCODE.DEL         + Keys.KEYCODE.ONDOWN,
    CMD:            Keys.KEYCODE.CMD         + Keys.KEYCODE.ONDOWN,
    RCMD:           Keys.KEYCODE.RCMD        + Keys.KEYCODE.ONDOWN,
    FF_CMD:         Keys.KEYCODE.FF_CMD      + Keys.KEYCODE.ONDOWN,
    CTRL_A:         Keys.ASCII.CTRL_A        + Keys.KEYCODE.FAKE,
    CTRL_B:         Keys.ASCII.CTRL_B        + Keys.KEYCODE.FAKE,
    CTRL_C:         Keys.ASCII.CTRL_C        + Keys.KEYCODE.FAKE,
    CTRL_D:         Keys.ASCII.CTRL_D        + Keys.KEYCODE.FAKE,
    CTRL_E:         Keys.ASCII.CTRL_E        + Keys.KEYCODE.FAKE,
    CTRL_F:         Keys.ASCII.CTRL_F        + Keys.KEYCODE.FAKE,
    CTRL_G:         Keys.ASCII.CTRL_G        + Keys.KEYCODE.FAKE,
    CTRL_H:         Keys.ASCII.CTRL_H        + Keys.KEYCODE.FAKE,
    CTRL_I:         Keys.ASCII.CTRL_I        + Keys.KEYCODE.FAKE,
    CTRL_J:         Keys.ASCII.CTRL_J        + Keys.KEYCODE.FAKE,
    CTRL_K:         Keys.ASCII.CTRL_K        + Keys.KEYCODE.FAKE,
    CTRL_L:         Keys.ASCII.CTRL_L        + Keys.KEYCODE.FAKE,
    CTRL_M:         Keys.ASCII.CTRL_M        + Keys.KEYCODE.FAKE,
    CTRL_N:         Keys.ASCII.CTRL_N        + Keys.KEYCODE.FAKE,
    CTRL_O:         Keys.ASCII.CTRL_O        + Keys.KEYCODE.FAKE,
    CTRL_P:         Keys.ASCII.CTRL_P        + Keys.KEYCODE.FAKE,
    CTRL_Q:         Keys.ASCII.CTRL_Q        + Keys.KEYCODE.FAKE,
    CTRL_R:         Keys.ASCII.CTRL_R        + Keys.KEYCODE.FAKE,
    CTRL_S:         Keys.ASCII.CTRL_S        + Keys.KEYCODE.FAKE,
    CTRL_T:         Keys.ASCII.CTRL_T        + Keys.KEYCODE.FAKE,
    CTRL_U:         Keys.ASCII.CTRL_U        + Keys.KEYCODE.FAKE,
    CTRL_V:         Keys.ASCII.CTRL_V        + Keys.KEYCODE.FAKE,
    CTRL_W:         Keys.ASCII.CTRL_W        + Keys.KEYCODE.FAKE,
    CTRL_X:         Keys.ASCII.CTRL_X        + Keys.KEYCODE.FAKE,
    CTRL_Y:         Keys.ASCII.CTRL_Y        + Keys.KEYCODE.FAKE,
    CTRL_Z:         Keys.ASCII.CTRL_Z        + Keys.KEYCODE.FAKE,
    SYS_REQ:        Keys.KEYCODE.ESC         + Keys.KEYCODE.FAKE,
    CTRL_PAUSE:     Keys.KEYCODE.NUM_LOCK    + Keys.KEYCODE.FAKE,
    CTRL_BREAK:     Keys.KEYCODE.SCROLL_LOCK + Keys.KEYCODE.FAKE,
    CTRL_ALT_DEL:   Keys.KEYCODE.DEL         + Keys.KEYCODE.FAKE,
    CTRL_ALT_INS:   Keys.KEYCODE.INS         + Keys.KEYCODE.FAKE,
    CTRL_ALT_ADD:   Keys.KEYCODE.NUM_ADD     + Keys.KEYCODE.FAKE,
    CTRL_ALT_SUB:   Keys.KEYCODE.NUM_SUB     + Keys.KEYCODE.FAKE,
    CTRL_ALT_ENTER: Keys.KEYCODE.NUM_CR      + Keys.KEYCODE.FAKE
};

/*
 * Scan code constants
 */
Keyboard.SCANCODE = {
    /* 0x01 */ ESC:         1,
    /* 0x02 */ ONE:         2,
    /* 0x03 */ TWO:         3,
    /* 0x04 */ THREE:       4,
    /* 0x05 */ FOUR:        5,
    /* 0x06 */ FIVE:        6,
    /* 0x07 */ SIX:         7,
    /* 0x08 */ SEVEN:       8,
    /* 0x09 */ EIGHT:       9,
    /* 0x0A */ NINE:        10,
    /* 0x0B */ ZERO:        11,
    /* 0x0C */ DASH:        12,
    /* 0x0D */ EQUALS:      13,
    /* 0x0E */ BS:          14,
    /* 0x0F */ TAB:         15,
    /* 0x10 */ Q:           16,
    /* 0x11 */ W:           17,
    /* 0x12 */ E:           18,
    /* 0x13 */ R:           19,
    /* 0x14 */ T:           20,
    /* 0x15 */ Y:           21,
    /* 0x16 */ U:           22,
    /* 0x17 */ I:           23,
    /* 0x18 */ O:           24,
    /* 0x19 */ P:           25,
    /* 0x1A */ LBRACK:      26,
    /* 0x1B */ RBRACK:      27,
    /* 0x1C */ ENTER:       28,
    /* 0x1D */ CTRL:        29,
    /* 0x1E */ A:           30,
    /* 0x1F */ S:           31,
    /* 0x20 */ D:           32,
    /* 0x21 */ F:           33,
    /* 0x22 */ G:           34,
    /* 0x23 */ H:           35,
    /* 0x24 */ J:           36,
    /* 0x25 */ K:           37,
    /* 0x26 */ L:           38,
    /* 0x27 */ SEMI:        39,
    /* 0x28 */ QUOTE:       40,
    /* 0x29 */ BQUOTE:      41,
    /* 0x2A */ SHIFT:       42,
    /* 0x2B */ BSLASH:      43,
    /* 0x2C */ Z:           44,
    /* 0x2D */ X:           45,
    /* 0x2E */ C:           46,
    /* 0x2F */ V:           47,
    /* 0x30 */ B:           48,
    /* 0x31 */ N:           49,
    /* 0x32 */ M:           50,
    /* 0x33 */ COMMA:       51,
    /* 0x34 */ PERIOD:      52,
    /* 0x35 */ SLASH:       53,
    /* 0x36 */ RSHIFT:      54,
    /* 0x37 */ PRTSC:       55,         // unshifted '*'; becomes dedicated 'Print Screen' key on 101-key keyboards
    /* 0x38 */ ALT:         56,
    /* 0x39 */ SPACE:       57,
    /* 0x3A */ CAPS_LOCK:   58,
    /* 0x3B */ F1:          59,
    /* 0x3C */ F2:          60,
    /* 0x3D */ F3:          61,
    /* 0x3E */ F4:          62,
    /* 0x3F */ F5:          63,
    /* 0x40 */ F6:          64,
    /* 0x41 */ F7:          65,
    /* 0x42 */ F8:          66,
    /* 0x43 */ F9:          67,
    /* 0x44 */ F10:         68,
    /* 0x45 */ NUM_LOCK:    69,
    /* 0x46 */ SCROLL_LOCK: 70,
    /* 0x47 */ NUM_HOME:    71,
    /* 0x48 */ NUM_UP:      72,
    /* 0x49 */ NUM_PGUP:    73,
    /* 0x4A */ NUM_SUB:     74,
    /* 0x4B */ NUM_LEFT:    75,
    /* 0x4C */ NUM_CENTER:  76,
    /* 0x4D */ NUM_RIGHT:   77,
    /* 0x4E */ NUM_ADD:     78,
    /* 0x4F */ NUM_END:     79,
    /* 0x50 */ NUM_DOWN:    80,
    /* 0x51 */ NUM_PGDN:    81,
    /* 0x52 */ NUM_INS:     82,
    /* 0x53 */ NUM_DEL:     83,
    /* 0x54 */ SYS_REQ:     84,         // 84-key keyboard only (simulated with 'alt'+'prtsc' on 101-key keyboards)
    /* 0x54 */ PAUSE:       84,         // 101-key keyboard only
    /* 0x57 */ F11:         87,
    /* 0x58 */ F12:         88,
    /* 0x5B */ WIN:         91,         // aka CMD
    /* 0x5C */ RWIN:        92,
    /* 0x5D */ MENU:        93,         // aka CMD + ONRIGHT
    /* 0x7F */ MAKE:        127,
    /* 0x80 */ BREAK:       128,
    /* 0xE0 */ EXTEND1:     224,
    /* 0xE1 */ EXTEND2:     225
};

/**
 * These internal "shift key" states are used to indicate BOTH the physical shift-key states (in bitsState)
 * and the simulated shift-key states (in bitsStateSim).  The LOCK keys are problematic in both cases: the
 * browsers give us no way to query the LOCK key states, so we can only infer them, and because they are "soft"
 * locks, the machine's notion of their state is subject to change at any time as well.  Granted, the IBM PC
 * ROM BIOS will store its LOCK states in the ROM BIOS Data Area (@0040:0017), but that's just a BIOS convention.
 *
 * Also, because this is purely for internal use, don't make the mistake of thinking that these bits have any
 * connection to the ROM BIOS bits @0040:0017 (they don't).  We emulate hardware, not ROMs.
 *
 * TODO: Consider taking notice of the ROM BIOS Data Area state anyway, even though I'd rather remain ROM-agnostic;
 * at the very least, it would help us keep our LOCK LEDs in sync with the machine's LOCK states.  However, the LED
 * issue will be largely moot (at least for MODEL_5170 machines) once we add support for PC AT keyboard LED commands.
 *
 * Note that right-hand state bits are equal to the left-hand bits shifted right 1 bit; makes sense, "right"? ;-)
 *
 * @enum {number}
 */
Keyboard.STATE = {
    RSHIFT:         0x0001,
    SHIFT:          0x0002,
    SHIFTS:         0x0003,
    RCTRL:          0x0004,             // 101-key keyboard only
    CTRL:           0x0008,
    CTRLS:          0x000C,
    RALT:           0x0010,             // 101-key keyboard only
    ALT:            0x0020,
    ALTS:           0x0030,
    RCMD:           0x0040,             // 101-key keyboard only
    CMD:            0x0080,             // 101-key keyboard only
    CMDS:           0x00C0,
    ALL_RIGHT:      0x0055,             // RSHIFT | RCTRL | RALT | RCMD
    ALL_MODIFIERS:  0x00FF,             // SHIFT | RSHIFT | CTRL | RCTRL | ALT | RALT | CMD | RCMD
    INSERT:         0x0100,             // TODO: Placeholder (we currently have no notion of any "insert" states)
    CAPS_LOCK:      0x0200,
    NUM_LOCK:       0x0400,
    SCROLL_LOCK:    0x0800,
    ALL_LOCKS:      0x0E00              // CAPS_LOCK | NUM_LOCK | SCROLL_LOCK
};

/*
 * Maps KEYCODES of modifier keys to their corresponding (default) STATES bit above.
 */
Keyboard.MODIFIERS = {
    [Keyboard.SIMCODE.RSHIFT]:      Keyboard.STATE.RSHIFT,
    [Keyboard.SIMCODE.SHIFT]:       Keyboard.STATE.SHIFT,
    [Keyboard.SIMCODE.CTRL]:        Keyboard.STATE.CTRL,
    [Keyboard.SIMCODE.ALT]:         Keyboard.STATE.ALT,
    [Keyboard.SIMCODE.RALT]:        Keyboard.STATE.ALT,
    [Keyboard.SIMCODE.CMD]:         Keyboard.STATE.CMD,
    [Keyboard.SIMCODE.RCMD]:        Keyboard.STATE.RCMD,
    [Keyboard.SIMCODE.FF_CMD]:      Keyboard.STATE.CMD
};

/*
 * Maps KEYCODES of all modifier and lock keys to their corresponding (default) STATES bit above.
 */
Keyboard.KEYSTATES = {
    [Keyboard.SIMCODE.RSHIFT]:      Keyboard.STATE.RSHIFT,
    [Keyboard.SIMCODE.SHIFT]:       Keyboard.STATE.SHIFT,
    [Keyboard.SIMCODE.CTRL]:        Keyboard.STATE.CTRL,
    [Keyboard.SIMCODE.ALT]:         Keyboard.STATE.ALT,
    [Keyboard.SIMCODE.RALT]:        Keyboard.STATE.ALT,
    [Keyboard.SIMCODE.CMD]:         Keyboard.STATE.CMD,
    [Keyboard.SIMCODE.RCMD]:        Keyboard.STATE.RCMD,
    [Keyboard.SIMCODE.FF_CMD]:      Keyboard.STATE.CMD,
    [Keyboard.SIMCODE.CAPS_LOCK]:   Keyboard.STATE.CAPS_LOCK,
    [Keyboard.SIMCODE.NUM_LOCK]:    Keyboard.STATE.NUM_LOCK,
    [Keyboard.SIMCODE.SCROLL_LOCK]: Keyboard.STATE.SCROLL_LOCK
};

/*
 * Maps CLICKCODE (string) to SIMCODE (number).
 *
 * NOTE: Unlike SOFTCODES, CLICKCODES are upper-case and use underscores instead of dashes, so that this
 * and other components can reference them using "dot" property syntax; using upper-case merely adheres to
 * our convention for constants.  setBinding() will automatically convert any incoming CLICKCODE bindings
 * that use lower-case and dashes to upper-case and underscores before performing property lookup.
 */
Keyboard.CLICKCODES = {
    'TAB':              Keyboard.SIMCODE.TAB,
    'ESC':              Keyboard.SIMCODE.ESC,
    'F1':               Keyboard.SIMCODE.F1,
    'F2':               Keyboard.SIMCODE.F2,
    'F3':               Keyboard.SIMCODE.F3,
    'F4':               Keyboard.SIMCODE.F4,
    'F5':               Keyboard.SIMCODE.F5,
    'F6':               Keyboard.SIMCODE.F6,
    'F7':               Keyboard.SIMCODE.F7,
    'F8':               Keyboard.SIMCODE.F8,
    'F9':               Keyboard.SIMCODE.F9,
    'F10':              Keyboard.SIMCODE.F10,
    'LEFT':             Keyboard.SIMCODE.LEFT,
    'UP':               Keyboard.SIMCODE.UP,
    'RIGHT':            Keyboard.SIMCODE.RIGHT,
    'DOWN':             Keyboard.SIMCODE.DOWN,
    'NUM_HOME':         Keyboard.SIMCODE.HOME,
    'NUM_END':          Keyboard.SIMCODE.END,
    'NUM_PGUP':         Keyboard.SIMCODE.PGUP,
    'NUM_PGDN':         Keyboard.SIMCODE.PGDN,
    'ALT':              Keyboard.SIMCODE.ALT,
    'SYS_REQ':          Keyboard.SIMCODE.SYS_REQ,
    /*
     * These bindings are for convenience (common key combinations that can be bound to a single control)
     */
    'CTRL_C':           Keyboard.SIMCODE.CTRL_C,
    'CTRL_PAUSE':       Keyboard.SIMCODE.CTRL_PAUSE,
    'CTRL_BREAK':       Keyboard.SIMCODE.CTRL_BREAK,
    'CTRL_ALT_DEL':     Keyboard.SIMCODE.CTRL_ALT_DEL,
    'CTRL_ALT_INS':     Keyboard.SIMCODE.CTRL_ALT_INS,
    'CTRL_ALT_ADD':     Keyboard.SIMCODE.CTRL_ALT_ADD,
    'CTRL_ALT_SUB':     Keyboard.SIMCODE.CTRL_ALT_SUB,
    'CTRL_ALT_ENTER':   Keyboard.SIMCODE.CTRL_ALT_ENTER
};

/*
 * Maps SOFTCODE (string) to SIMCODE (number) -- which may be the same as KEYCODE for ASCII keys.
 *
 * We define identifiers for all possible keys, based on their primary (unshifted) character or function.
 * This also serves as a definition of all supported keys, making it possible to create full-featured
 * "soft keyboards".
 *
 * One exception to the (unshifted) rule above is 'prtsc': on the original IBM 83-key and 84-key keyboards,
 * its primary (unshifted) character was '*', but on 101-key keyboards, it became a separate key ('prtsc',
 * now labeled "Print Screen"), as did the num-pad '*' ('num-mul'), so 'prtsc' seems worthy of an exception
 * to the rule.
 *
 * On 83-key and 84-key keyboards, 'ctrl'+'num-lock' triggered a "pause" operation and 'ctrl'+'scroll-lock'
 * triggered a "break" operation.
 *
 * On 101-key keyboards, IBM decided to move both those special operations to a new 'pause' ("Pause/Break")
 * key, near the new dedicated 'prtsc' ("Print Screen/SysRq") key -- and to drop the "e" from "Sys Req".
 * Those keys behave as follows:
 *
 *      When 'pause' is pressed alone, it generates 0xe1 0x1d 0x45 0xe1 0x9d 0xc5 on make (nothing on break),
 *      which essentially simulates the make-and-break of the 'ctrl' and 'num-lock' keys (ignoring the 0xe1),
 *      triggering a "pause" operation.
 *
 *      When 'pause' is pressed with 'ctrl', it generates 0xe0 0x46 0xe0 0xc6 on make (nothing on break) and
 *      does not repeat, which essentially simulates the make-and-break of 'scroll-lock', which, in conjunction
 *      with the separate make-and-break of 'ctrl', triggers a "break" operation.
 *
 *      When 'prtsc' is pressed alone, it generates 0xe0 0x2a 0xe0 0x37, simulating the make of both 'shift'
 *      and 'prtsc'; when pressed with 'shift' or 'ctrl', it generates only 0xe0 0x37; and when pressed with
 *      'alt', it generates only 0x54 (to simulate 'sys-req').
 *
 * TODO: Implement the above behaviors, whenever we get around to actually supporting 101-key keyboards.
 *
 * All key identifiers must be quotable using single-quotes, because that's how components.xsl will encode them
 * *inside* the "data-value" attribute of the corresponding HTML control.  Which, in turn, is why the single-quote
 * key is defined as 'quote' rather than "'".  Similarly, if there was unshifted "double-quote" key, it could
 * not be called '"', because components.xsl quotes the *entire* "data-value" attribute using double-quotes.
 *
 * The (commented) numbering of keys below is purely for my own reference.  Two keys are deliberately numbered 84,
 * reflecting the fact that the 'sys-req' key was added to the 84-key keyboard but later dropped from the 101-key
 * keyboard (as a stand-alone key, that is).
 *
 * With the introduction of the PC AT and the 84-key keyboard, IBM developed a new key numbering scheme and
 * key code generation; the 8042 keyboard controller would then convert those key codes into the PC scan codes
 * defined by the older 83-key keyboard.  That's a layer of complexity we currently bypass; instead, we continue
 * to convert browser key codes directly into PC scan codes, which is what our 8042 controller implementation
 * assumes we're doing.
 */
Keyboard.SOFTCODES = {
    /*  1 */    'esc':          Keyboard.SIMCODE.ESC,
    /*  2 */    '1':            Keys.ASCII['1'],
    /*  3 */    '2':            Keys.ASCII['2'],
    /*  4 */    '3':            Keys.ASCII['3'],
    /*  5 */    '4':            Keys.ASCII['4'],
    /*  6 */    '5':            Keys.ASCII['5'],
    /*  7 */    '6':            Keys.ASCII['6'],
    /*  8 */    '7':            Keys.ASCII['7'],
    /*  9 */    '8':            Keys.ASCII['8'],
    /* 10 */    '9':            Keys.ASCII['9'],
    /* 11 */    '0':            Keys.ASCII['0'],
    /* 12 */    '-':            Keys.ASCII['-'],
    /* 13 */    '=':            Keys.ASCII['='],
    /* 14 */    'bs':           Keyboard.SIMCODE.BS,
    /* 15 */    'tab':          Keyboard.SIMCODE.TAB,
    /* 16 */    'q':            Keys.ASCII.q,
    /* 17 */    'w':            Keys.ASCII.w,
    /* 18 */    'e':            Keys.ASCII.e,
    /* 19 */    'r':            Keys.ASCII.r,
    /* 20 */    't':            Keys.ASCII.t,
    /* 21 */    'y':            Keys.ASCII.y,
    /* 22 */    'u':            Keys.ASCII.u,
    /* 23 */    'i':            Keys.ASCII.i,
    /* 24 */    'o':            Keys.ASCII.o,
    /* 25 */    'p':            Keys.ASCII.p,
    /* 26 */    '[':            Keys.ASCII['['],
    /* 27 */    ']':            Keys.ASCII[']'],
    /* 28 */    'enter':        Keys.KEYCODE.CR,
    /* 29 */    'ctrl':         Keyboard.SIMCODE.CTRL,
    /* 30 */    'a':            Keys.ASCII.a,
    /* 31 */    's':            Keys.ASCII.s,
    /* 32 */    'd':            Keys.ASCII.d,
    /* 33 */    'f':            Keys.ASCII.f,
    /* 34 */    'g':            Keys.ASCII.g,
    /* 35 */    'h':            Keys.ASCII.h,
    /* 36 */    'j':            Keys.ASCII.j,
    /* 37 */    'k':            Keys.ASCII.k,
    /* 38 */    'l':            Keys.ASCII.l,
    /* 39 */    ';':            Keys.ASCII[';'],
    /* 40 */    'quote':        Keys.ASCII["'"],                // formerly "squote"
    /* 41 */    '`':            Keys.ASCII['`'],                // formerly "bquote"
    /* 42 */    'shift':        Keyboard.SIMCODE.SHIFT,         // formerly "lshift"
    /* 43 */    '\\':           Keys.ASCII['\\'],               // formerly "bslash"
    /* 44 */    'z':            Keys.ASCII.z,
    /* 45 */    'x':            Keys.ASCII.x,
    /* 46 */    'c':            Keys.ASCII.c,
    /* 47 */    'v':            Keys.ASCII.v,
    /* 48 */    'b':            Keys.ASCII.b,
    /* 49 */    'n':            Keys.ASCII.n,
    /* 50 */    'm':            Keys.ASCII.m,
    /* 51 */    ',':            Keys.ASCII[','],
    /* 52 */    '.':            Keys.ASCII['.'],
    /* 53 */    '/':            Keys.ASCII['/'],
    /* 54 */    'right-shift':  Keyboard.SIMCODE.RSHIFT,        // formerly "rshift"
    /* 55 */    'prtsc':        Keyboard.SIMCODE.PRTSC,         // unshifted '*'; becomes dedicated 'Print Screen' key on 101-key keyboards
    /* 56 */    'alt':          Keyboard.SIMCODE.ALT,
    /* 57 */    'space':        Keyboard.SIMCODE.SPACE,
    /* 58 */    'caps-lock':    Keyboard.SIMCODE.CAPS_LOCK,
    /* 59 */    'f1':           Keyboard.SIMCODE.F1,
    /* 60 */    'f2':           Keyboard.SIMCODE.F2,
    /* 61 */    'f3':           Keyboard.SIMCODE.F3,
    /* 62 */    'f4':           Keyboard.SIMCODE.F4,
    /* 63 */    'f5':           Keyboard.SIMCODE.F5,
    /* 64 */    'f6':           Keyboard.SIMCODE.F6,
    /* 65 */    'f7':           Keyboard.SIMCODE.F7,
    /* 66 */    'f8':           Keyboard.SIMCODE.F8,
    /* 67 */    'f9':           Keyboard.SIMCODE.F9,
    /* 68 */    'f10':          Keyboard.SIMCODE.F10,
    /* 69 */    'num-lock':     Keyboard.SIMCODE.NUM_LOCK,
    /* 70 */    'scroll-lock':  Keyboard.SIMCODE.SCROLL_LOCK,   // TODO: 0xe046 on 101-key keyboards?

    /*
     * Yes, distinguishing keys 71 through 83 with the 'num-' prefix seems like overkill, but it was
     * intended to be future-proofing, for the day when we might eventually add support for 101-key keyboards,
     * because they have their own dedicated non-numeric-keypad versions of these keys (in other words, they
     * account for most of the bloat on the 101-key keyboard, a trend that more modern keyboards have gradually
     * been reversing).
     *
     * To offset 'num-' prefix overkill, injectKeys() allows SOFTCODES to be used with or without the prefix,
     * on the theory that key injection users won't really care precisely which version of the key is used.
     */

    /* 71 */    'num-home':     Keyboard.SIMCODE.HOME,          // formerly "home"
    /* 72 */    'num-up':       Keyboard.SIMCODE.UP,            // formerly "up-arrow"
    /* 73 */    'num-pgup':     Keyboard.SIMCODE.PGUP,          // formerly "page-up"
    /* 74 */    'num-sub':      Keyboard.SIMCODE.NUM_SUB,       // formerly "num-minus"
    /* 75 */    'num-left':     Keyboard.SIMCODE.LEFT,          // formerly "left-arrow"
    /* 76 */    'num-center':   Keyboard.SIMCODE.NUM_CENTER,    // formerly "center"
    /* 77 */    'num-right':    Keyboard.SIMCODE.RIGHT,         // formerly "right-arrow"
    /* 78 */    'num-add':      Keyboard.SIMCODE.NUM_ADD,       // formerly "num-plus"
    /* 79 */    'num-end':      Keyboard.SIMCODE.END,           // formerly "end"
    /* 80 */    'num-down':     Keyboard.SIMCODE.DOWN,          // formerly "down-arrow"
    /* 81 */    'num-pgdn':     Keyboard.SIMCODE.PGDN,          // formerly "page-down"
    /* 82 */    'num-ins':      Keyboard.SIMCODE.INS,           // formerly "ins"
    /* 83 */    'num-del':      Keyboard.SIMCODE.DEL,           // formerly "del"
    /* 84 */    'sys-req':      Keyboard.SIMCODE.SYS_REQ        // 84-key keyboard only (simulated with 'alt'+'prtsc' on 101-key keyboards)

    /*
     * If I ever add 101-key keyboard support (and it's not clear that I will), then the following entries
     * will have to be converted to SIMCODE indexes, and each SIMCODE index will need an entry in the SIMCODES
     * table that defines the appropriate SCANCODE(S); as this component has evolved, SOFTCODES are no longer
     * mapped directly to SCANCODES.
     */

//  /* 84 */    'pause':        Keyboard.SCANCODE.PAUSE,        // 101-key keyboard only
//  /* 85 */    'f11':          Keyboard.SCANCODE.F11,
//  /* 86 */    'f12':          Keyboard.SCANCODE.F12,
//  /* 87 */    'num-enter':    Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.ENTER << 8),
//  /* 88 */    'right-ctrl':   Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.CTRL << 8),
//  /* 89 */    'num-div':      Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.SLASH << 8),
//  /* 90 */    'num-mul':      Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.PRTSC << 8),
//  /* 91 */    'right-alt':    Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.ALT << 8),
//  /* 92 */    'home':         Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_HOME << 8),
//  /* 93 */    'up':           Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_UP << 8),
//  /* 94 */    'pgup':         Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_PGUP << 8),
//  /* 95 */    'left':         Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_LEFT << 8),
//  /* 96 */    'right':        Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_RIGHT << 8),
//  /* 97 */    'end':          Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_END << 8),
//  /* 98 */    'down':         Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_DOWN << 8),
//  /* 99 */    'pgdn':         Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_PGDN << 8),
//  /*100 */    'ins':          Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_INS << 8),
//  /*101 */    'del':          Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.NUM_DEL << 8),

//  /*102 */    'win':          Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.WIN << 8),
//  /*103 */    'right-win':    Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.RWIN << 8),
//  /*104 */    'menu':         Keyboard.SCANCODE.EXTEND1 | (Keyboard.SCANCODE.MENU << 8)
};

/*
 * Maps "soft-key" definitions (above) of shift/modifier keys to their corresponding (default) STATES bit.
 */
Keyboard.LEDSTATES = {
    'caps-lock':    Keyboard.STATE.CAPS_LOCK,
    'num-lock':     Keyboard.STATE.NUM_LOCK,
    'scroll-lock':  Keyboard.STATE.SCROLL_LOCK
};

/*
 * Maps SIMCODE (number) to SCANCODE (number(s)).
 *
 * This array is used by keySimulate() to lookup a given SIMCODE and convert it to a SCANCODE
 * (lower byte), plus any required shift key SCANCODES (upper bytes).
 *
 * Using keyCodes from keyPress events proved to be more robust than using keyCodes from keyDown and
 * keyUp events, in part because of differences in the way browsers generate the keyDown and keyUp events.
 * For example, Safari on iOS devices will not generate up/down events for shift keys, and for other keys,
 * the up/down events are usually generated after the actual press is complete, and in rapid succession.
 *
 * The other problem (which is more of a problem with keyboards like the C1P than any IBM keyboards) is
 * that the shift/modifier state for a character on the "source" keyboard may not match the shift/modifier
 * state for the same character on the "target" keyboard.  And since this code is inherited from C1Pjs,
 * we've inherited the same solution: keySimulate() has the ability to "undo" any states in bitsState
 * that conflict with the state(s) required for the character in question.
 */
Keyboard.SIMCODES = {
    [Keyboard.SIMCODE.ESC]:         Keyboard.SCANCODE.ESC,
    [Keys.ASCII['1']]:              Keyboard.SCANCODE.ONE,
    [Keys.ASCII['!']]:              Keyboard.SCANCODE.ONE    | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['2']]:              Keyboard.SCANCODE.TWO,
    [Keys.ASCII['@']]:              Keyboard.SCANCODE.TWO    | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['3']]:              Keyboard.SCANCODE.THREE,
    [Keys.ASCII['#']]:              Keyboard.SCANCODE.THREE  | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['4']]:              Keyboard.SCANCODE.FOUR,
    [Keys.ASCII['$']]:              Keyboard.SCANCODE.FOUR   | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['5']]:              Keyboard.SCANCODE.FIVE,
    [Keys.ASCII['%']]:              Keyboard.SCANCODE.FIVE   | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['6']]:              Keyboard.SCANCODE.SIX,
    [Keys.ASCII['^']]:              Keyboard.SCANCODE.SIX    | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['7']]:              Keyboard.SCANCODE.SEVEN,
    [Keys.ASCII['&']]:              Keyboard.SCANCODE.SEVEN  | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['8']]:              Keyboard.SCANCODE.EIGHT,
    [Keys.ASCII['*']]:              Keyboard.SCANCODE.EIGHT  | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['9']]:              Keyboard.SCANCODE.NINE,
    [Keys.ASCII['(']]:              Keyboard.SCANCODE.NINE   | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['0']]:              Keyboard.SCANCODE.ZERO,
    [Keys.ASCII[')']]:              Keyboard.SCANCODE.ZERO   | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['-']]:              Keyboard.SCANCODE.DASH,
    [Keys.ASCII['_']]:              Keyboard.SCANCODE.DASH   | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['=']]:              Keyboard.SCANCODE.EQUALS,
    [Keys.ASCII['+']]:              Keyboard.SCANCODE.EQUALS | (Keyboard.SCANCODE.SHIFT << 8),
    [Keyboard.SIMCODE.BS]:          Keyboard.SCANCODE.BS,
    [Keyboard.SIMCODE.TAB]:         Keyboard.SCANCODE.TAB,
    [Keys.ASCII.q]:                 Keyboard.SCANCODE.Q,
    [Keys.ASCII.Q]:                 Keyboard.SCANCODE.Q      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.w]:                 Keyboard.SCANCODE.W,
    [Keys.ASCII.W]:                 Keyboard.SCANCODE.W      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.e]:                 Keyboard.SCANCODE.E,
    [Keys.ASCII.E]:                 Keyboard.SCANCODE.E      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.r]:                 Keyboard.SCANCODE.R,
    [Keys.ASCII.R]:                 Keyboard.SCANCODE.R      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.t]:                 Keyboard.SCANCODE.T,
    [Keys.ASCII.T]:                 Keyboard.SCANCODE.T      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.y]:                 Keyboard.SCANCODE.Y,
    [Keys.ASCII.Y]:                 Keyboard.SCANCODE.Y      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.u]:                 Keyboard.SCANCODE.U,
    [Keys.ASCII.U]:                 Keyboard.SCANCODE.U      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.i]:                 Keyboard.SCANCODE.I,
    [Keys.ASCII.I]:                 Keyboard.SCANCODE.I      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.o]:                 Keyboard.SCANCODE.O,
    [Keys.ASCII.O]:                 Keyboard.SCANCODE.O      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.p]:                 Keyboard.SCANCODE.P,
    [Keys.ASCII.P]:                 Keyboard.SCANCODE.P      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['[']]:              Keyboard.SCANCODE.LBRACK,
    [Keys.ASCII['{']]:              Keyboard.SCANCODE.LBRACK | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII[']']]:              Keyboard.SCANCODE.RBRACK,
    [Keys.ASCII['}']]:              Keyboard.SCANCODE.RBRACK | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.KEYCODE.CR]:              Keyboard.SCANCODE.ENTER,
    [Keyboard.SIMCODE.CTRL]:        Keyboard.SCANCODE.CTRL,
    [Keys.ASCII.a]:                 Keyboard.SCANCODE.A,
    [Keys.ASCII.A]:                 Keyboard.SCANCODE.A      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.s]:                 Keyboard.SCANCODE.S,
    [Keys.ASCII.S]:                 Keyboard.SCANCODE.S      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.d]:                 Keyboard.SCANCODE.D,
    [Keys.ASCII.D]:                 Keyboard.SCANCODE.D      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.f]:                 Keyboard.SCANCODE.F,
    [Keys.ASCII.F]:                 Keyboard.SCANCODE.F      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.g]:                 Keyboard.SCANCODE.G,
    [Keys.ASCII.G]:                 Keyboard.SCANCODE.G      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.h]:                 Keyboard.SCANCODE.H,
    [Keys.ASCII.H]:                 Keyboard.SCANCODE.H      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.j]:                 Keyboard.SCANCODE.J,
    [Keys.ASCII.J]:                 Keyboard.SCANCODE.J      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.k]:                 Keyboard.SCANCODE.K,
    [Keys.ASCII.K]:                 Keyboard.SCANCODE.K      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.l]:                 Keyboard.SCANCODE.L,
    [Keys.ASCII.L]:                 Keyboard.SCANCODE.L      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII[';']]:              Keyboard.SCANCODE.SEMI,
    [Keys.ASCII[':']]:              Keyboard.SCANCODE.SEMI   | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII["'"]]:              Keyboard.SCANCODE.QUOTE,
    [Keys.ASCII['"']]:              Keyboard.SCANCODE.QUOTE  | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['`']]:              Keyboard.SCANCODE.BQUOTE,
    [Keys.ASCII['~']]:              Keyboard.SCANCODE.BQUOTE | (Keyboard.SCANCODE.SHIFT << 8),
    [Keyboard.SIMCODE.SHIFT]:       Keyboard.SCANCODE.SHIFT,
    [Keys.ASCII['\\']]:             Keyboard.SCANCODE.BSLASH,
    [Keys.ASCII['|']]:              Keyboard.SCANCODE.BSLASH | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.z]:                 Keyboard.SCANCODE.Z,
    [Keys.ASCII.Z]:                 Keyboard.SCANCODE.Z      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.x]:                 Keyboard.SCANCODE.X,
    [Keys.ASCII.X]:                 Keyboard.SCANCODE.X      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.c]:                 Keyboard.SCANCODE.C,
    [Keys.ASCII.C]:                 Keyboard.SCANCODE.C      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.v]:                 Keyboard.SCANCODE.V,
    [Keys.ASCII.V]:                 Keyboard.SCANCODE.V      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.b]:                 Keyboard.SCANCODE.B,
    [Keys.ASCII.B]:                 Keyboard.SCANCODE.B      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.n]:                 Keyboard.SCANCODE.N,
    [Keys.ASCII.N]:                 Keyboard.SCANCODE.N      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII.m]:                 Keyboard.SCANCODE.M,
    [Keys.ASCII.M]:                 Keyboard.SCANCODE.M      | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII[',']]:              Keyboard.SCANCODE.COMMA,
    [Keys.ASCII['<']]:              Keyboard.SCANCODE.COMMA  | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['.']]:              Keyboard.SCANCODE.PERIOD,
    [Keys.ASCII['>']]:              Keyboard.SCANCODE.PERIOD | (Keyboard.SCANCODE.SHIFT << 8),
    [Keys.ASCII['/']]:              Keyboard.SCANCODE.SLASH,
    [Keys.ASCII['?']]:              Keyboard.SCANCODE.SLASH  | (Keyboard.SCANCODE.SHIFT << 8),
    [Keyboard.SIMCODE.RSHIFT]:      Keyboard.SCANCODE.RSHIFT,
    [Keyboard.SIMCODE.PRTSC]:       Keyboard.SCANCODE.PRTSC,
    [Keyboard.SIMCODE.ALT]:         Keyboard.SCANCODE.ALT,
    [Keyboard.SIMCODE.RALT]:        Keyboard.SCANCODE.ALT,
    [Keyboard.SIMCODE.SPACE]:       Keyboard.SCANCODE.SPACE,
    [Keyboard.SIMCODE.CAPS_LOCK]:   Keyboard.SCANCODE.CAPS_LOCK,
    [Keyboard.SIMCODE.F1]:          Keyboard.SCANCODE.F1,
    [Keyboard.SIMCODE.F2]:          Keyboard.SCANCODE.F2,
    [Keyboard.SIMCODE.F3]:          Keyboard.SCANCODE.F3,
    [Keyboard.SIMCODE.F4]:          Keyboard.SCANCODE.F4,
    [Keyboard.SIMCODE.F5]:          Keyboard.SCANCODE.F5,
    [Keyboard.SIMCODE.F6]:          Keyboard.SCANCODE.F6,
    [Keyboard.SIMCODE.F7]:          Keyboard.SCANCODE.F7,
    [Keyboard.SIMCODE.F8]:          Keyboard.SCANCODE.F8,
    [Keyboard.SIMCODE.F9]:          Keyboard.SCANCODE.F9,
    [Keyboard.SIMCODE.F10]:         Keyboard.SCANCODE.F10,
    [Keyboard.SIMCODE.NUM_LOCK]:    Keyboard.SCANCODE.NUM_LOCK,
    [Keyboard.SIMCODE.SCROLL_LOCK]: Keyboard.SCANCODE.SCROLL_LOCK,
    [Keyboard.SIMCODE.HOME]:        Keyboard.SCANCODE.NUM_HOME,
    [Keyboard.SIMCODE.NUM_HOME]:    Keyboard.SCANCODE.NUM_HOME,
    [Keyboard.SIMCODE.UP]:          Keyboard.SCANCODE.NUM_UP,
    [Keyboard.SIMCODE.NUM_UP]:      Keyboard.SCANCODE.NUM_UP,
    [Keyboard.SIMCODE.PGUP]:        Keyboard.SCANCODE.NUM_PGUP,
    [Keyboard.SIMCODE.NUM_PGUP]:    Keyboard.SCANCODE.NUM_PGUP,
    [Keyboard.SIMCODE.LEFT]:        Keyboard.SCANCODE.NUM_LEFT,
    [Keyboard.SIMCODE.NUM_LEFT]:    Keyboard.SCANCODE.NUM_LEFT,
    [Keyboard.SIMCODE.NUM_CENTER]:  Keyboard.SCANCODE.NUM_CENTER,
    [Keyboard.SIMCODE.RIGHT]:       Keyboard.SCANCODE.NUM_RIGHT,
    [Keyboard.SIMCODE.NUM_RIGHT]:   Keyboard.SCANCODE.NUM_RIGHT,
    [Keyboard.SIMCODE.END]:         Keyboard.SCANCODE.NUM_END,
    [Keyboard.SIMCODE.NUM_END]:     Keyboard.SCANCODE.NUM_END,
    [Keyboard.SIMCODE.DOWN]:        Keyboard.SCANCODE.NUM_DOWN,
    [Keyboard.SIMCODE.NUM_DOWN]:    Keyboard.SCANCODE.NUM_DOWN,
    [Keyboard.SIMCODE.PGDN]:        Keyboard.SCANCODE.NUM_PGDN,
    [Keyboard.SIMCODE.NUM_PGDN]:    Keyboard.SCANCODE.NUM_PGDN,
    [Keyboard.SIMCODE.INS]:         Keyboard.SCANCODE.NUM_INS,
    [Keyboard.SIMCODE.NUM_INS]:     Keyboard.SCANCODE.NUM_INS,
    [Keyboard.SIMCODE.NUM_ADD]:     Keyboard.SCANCODE.NUM_ADD,
    [Keyboard.SIMCODE.NUM_SUB]:     Keyboard.SCANCODE.NUM_SUB,
    [Keyboard.SIMCODE.DEL]:         Keyboard.SCANCODE.NUM_DEL,
    [Keyboard.SIMCODE.NUM_DEL]:     Keyboard.SCANCODE.NUM_DEL,
    [Keyboard.SIMCODE.SYS_REQ]:     Keyboard.SCANCODE.SYS_REQ,
    /*
     * Entries beyond this point are for keys that existed only on 101-key keyboards (well, except for 'sys-req',
     * which also existed on the 84-key keyboard), which ALSO means that these keys essentially did not exist
     * for a MODEL_5150 or MODEL_5160 machine, because those machines could use only 83-key keyboards.  Remember
     * that IBM machines and IBM keyboards are our reference point here, so while there were undoubtedly 5150/5160
     * clones that could use newer keyboards, as well as 3rd-party keyboards that could work with older machines,
     * support for non-IBM configurations is left for another day.
     *
     * TODO: The only relevance of newer keyboards to older machines is the fact that you're probably using a newer
     * keyboard with your browser, which raises the question of what to do with newer keys that older machines
     * wouldn't understand.  I don't attempt to filter out any of the entries below based on machine model, but that
     * would seem like a wise thing to do.
     *
     * TODO: Add entries for 'num-mul', 'num-div', 'num-enter', the stand-alone arrow keys, etc, AND at the same time,
     * make sure that keys with multi-byte sequences (eg, 0xe0 0x1c) work properly.
     */
    [Keyboard.SIMCODE.F11]:         Keyboard.SCANCODE.F11,
    [Keyboard.SIMCODE.F12]:         Keyboard.SCANCODE.F12,
    [Keyboard.SIMCODE.CMD]:         Keyboard.SCANCODE.WIN,
    [Keyboard.SIMCODE.RCMD]:        Keyboard.SCANCODE.MENU,
    [Keyboard.SIMCODE.FF_CMD]:      Keyboard.SCANCODE.WIN,

    [Keyboard.SIMCODE.CTRL_A]:      Keyboard.SCANCODE.A           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_B]:      Keyboard.SCANCODE.B           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_C]:      Keyboard.SCANCODE.C           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_D]:      Keyboard.SCANCODE.D           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_E]:      Keyboard.SCANCODE.E           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_F]:      Keyboard.SCANCODE.F           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_G]:      Keyboard.SCANCODE.G           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_H]:      Keyboard.SCANCODE.H           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_I]:      Keyboard.SCANCODE.I           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_J]:      Keyboard.SCANCODE.J           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_K]:      Keyboard.SCANCODE.K           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_L]:      Keyboard.SCANCODE.L           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_M]:      Keyboard.SCANCODE.M           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_N]:      Keyboard.SCANCODE.N           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_O]:      Keyboard.SCANCODE.O           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_P]:      Keyboard.SCANCODE.P           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_Q]:      Keyboard.SCANCODE.Q           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_R]:      Keyboard.SCANCODE.R           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_S]:      Keyboard.SCANCODE.S           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_T]:      Keyboard.SCANCODE.T           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_U]:      Keyboard.SCANCODE.U           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_V]:      Keyboard.SCANCODE.V           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_W]:      Keyboard.SCANCODE.W           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_X]:      Keyboard.SCANCODE.X           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_Y]:      Keyboard.SCANCODE.Y           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_Z]:      Keyboard.SCANCODE.Z           | (Keyboard.SCANCODE.CTRL << 8),
    [Keyboard.SIMCODE.CTRL_BREAK]:  Keyboard.SCANCODE.SCROLL_LOCK | (Keyboard.SCANCODE.CTRL << 8),

    [Keyboard.SIMCODE.CTRL_ALT_DEL]:    Keyboard.SCANCODE.NUM_DEL | (Keyboard.SCANCODE.CTRL << 8) | (Keyboard.SCANCODE.ALT << 16),
    [Keyboard.SIMCODE.CTRL_ALT_INS]:    Keyboard.SCANCODE.NUM_INS | (Keyboard.SCANCODE.CTRL << 8) | (Keyboard.SCANCODE.ALT << 16),
    [Keyboard.SIMCODE.CTRL_ALT_ADD]:    Keyboard.SCANCODE.NUM_ADD | (Keyboard.SCANCODE.CTRL << 8) | (Keyboard.SCANCODE.ALT << 16),
    [Keyboard.SIMCODE.CTRL_ALT_SUB]:    Keyboard.SCANCODE.NUM_SUB | (Keyboard.SCANCODE.CTRL << 8) | (Keyboard.SCANCODE.ALT << 16),
    [Keyboard.SIMCODE.CTRL_ALT_ENTER]:  Keyboard.SCANCODE.ENTER   | (Keyboard.SCANCODE.CTRL << 8) | (Keyboard.SCANCODE.ALT << 16)
};

/**
 * Commands that can be sent to the Keyboard via the 8042; see receiveCmd()
 *
 * Aside from the commands listed below, 0xEF-0xF2 and 0xF7-0xFD are expressly documented as NOPs; ie:
 *
 *      These commands are reserved and are effectively no-operation or NOP. The system does not use these codes.
 *      If sent, the keyboard will acknowledge the command and continue in its prior scanning state. No other
 *      operation will occur.
 *
 * However, IBM's documentation is silent with regard to 0x00-0xEC.  It's likely that most if not all of those
 * commands are NOPs as well.
 *
 * @enum {number}
 */
Keyboard.CMD = {
    /*
     * RESET (0xFF)
     *
     * The system issues a RESET command to start a program reset and a keyboard internal self-test. The keyboard
     * acknowledges the command with an 'acknowledge' signal (ACK) and ensures the system accepts the ACK before
     * executing the command. The system signals acceptance of the ACK by raising the clock and data for a minimum
     * of 500 microseconds. The keyboard is disabled from the time it receives the RESET command until the ACK is
     * accepted or until another command overrides the previous one. Following acceptance of the ACK, the keyboard
     * begins the reset operation, which is similar to a power-on reset. The keyboard clears the output buffer and
     * sets up default values for typematic and delay rates.
     */
    RESET:      0xFF,

    /*
     * RESEND (0xFE)
     *
     * The system can send this command when it detects an error in any transmission from the keyboard. It can be
     * sent only after a keyboard transmission and before the system enables the interface to allow the next keyboard
     * output. Upon receipt of RESEND, the keyboard sends the previous output again unless the previous output was
     * RESEND. In this case, the keyboard will resend the last byte before the RESEND command.
     */
    RESEND:     0xFE,

    /*
     * SET DEFAULT (0xF6)
     *
     * The SET DEFAULT command resets all conditions to the power-on default state. The keyboard responds with ACK,
     * clears its output buffer, sets default conditions, and continues scanning (only if the keyboard was previously
     * enabled).
     */
    DEF_ON:     0xF6,

    /*
     * DEFAULT DISABLE (0xF5)
     *
     * This command is similar to SET DEFAULT, except the keyboard stops scanning and awaits further instructions.
     */
    DEF_OFF:    0xF5,

    /*
     * ENABLE (0xF4)
     *
     * Upon receipt of this command, the keyboard responds with ACK, clears its output buffer, and starts scanning.
     */
    ENABLE:     0xF4,

    /*
     * SET TYPEMATIC RATE/DELAY (0xF3)
     *
     * The system issues this command, followed by a parameter, to change the typematic rate and delay. The typematic
     * rate and delay parameters are determined by the value of the byte following the command. Bits 6 and 5 serve as
     * the delay parameter and bits 4,3,2, 1, and 0 (the least-significant bit) are the rate parameter. Bit 7, the
     * most-significant bit, is always 0. The delay is equal to 1 plus the binary value of bits 6 and 5 multiplied by
     * 250 milliseconds ±20%.
     */
    SET_RATE:   0xF3,

    /*
     * ECHO (0xEE)
     *
     * ECHO is a diagnostic aid. When the keyboard receives this command, it issues a 0xEE response and continues
     * scanning if the keyboard was previously enabled.
     */
    ECHO:       0xEE,

    /*
     * SET/RESET MODE INDICATORS (0xED)
     *
     * Three mode indicators on the keyboard are accessible to the system. The keyboard activates or deactivates
     * these indicators when it receives a valid command from the system. They can be activated or deactivated in
     * any combination.
     *
     * The system remembers the previous state of an indicator so that its setting does not change when a command
     * sequence is issued to change the state of another indicator.
     *
     * A SET/RESET MODE INDICATORS command consists of 2 bytes. The first is the command byte and has the following
     * bit setup:
     *
     *      11101101 - 0xED
     *
     * The second byte is an option byte. It has a list of the indicators to be acted upon. The bit assignments for
     * this option byte are as follows:
     *
     *      Bit         Indicator
     *      ---         ---------
     *       0          Scroll Lock Indicator
     *       1          Num Lock Indicator
     *       2          Caps Lock Indicator
     *      3-7         Reserved (must be 0's)
     *
     * NOTE: Bit 7 is the most-significant bit; bit 0 is the least-significant.
     *
     * The keyboard will respond to the set/reset mode indicators command with an ACK, discontinue scanning, and wait
     * for the option byte. The keyboard will respond to the option byte with an ACK, set the indicators, and continue
     * scanning if the keyboard was previously enabled. If another command is received in place of the option byte,
     * execution of the function of the SET/RESET MODE INDICATORS command is stopped with no change to the indicator
     * states, and the new command is processed. Then scanning is resumed.
     */
    SET_LEDS:   0xED
};

/**
 * Command responses returned to the Keyboard via the 8042; see receiveCmd()
 *
 * @enum {number}
 */
Keyboard.CMDRES = {
    /*
     * OVERRUN (0x00)
     *
     * An overrun character is placed in position 17 of the keyboard buffer, overlaying the last code if the
     * buffer becomes full. The code is sent to the system as an overrun when it reaches the top of the buffer.
     */
    OVERRUN:    0x00,

    LOAD_TEST:  0x65,   // undocumented "LOAD MANUFACTURING TEST REQUEST" response code

    /*
     * BAT Completion Code (0xAA)
     *
     * Following satisfactory completion of the BAT, the keyboard sends 0xAA. 0xFC (or any other code)
     * means the keyboard microprocessor check failed.
     */
    BAT_OK:     0xAA,

    /*
     * ECHO Response (0xEE)
     *
     * This is sent in response to an ECHO command (also 0xEE) from the system.
     */
    ECHO:       0xEE,

    /*
     * BREAK CODE PREFIX (0xF0)
     *
     * This code is sent as the first byte of a 2-byte sequence to indicate the release of a key.
     */
    BREAK_PREF: 0xF0,

    /*
     * ACK (0xFA)
     *
     * The keyboard issues an ACK response to any valid input other than an ECHO or RESEND command.
     * If the keyboard is interrupted while sending ACK, it will discard ACK and accept and respond
     * to the new command.
     */
    ACK:        0xFA,

    /*
     * BASIC ASSURANCE TEST FAILURE (0xFC)
     */
    BAT_FAIL:   0xFC,   // TODO: Verify this response code (is this just for older 83-key keyboards?)

    /*
     * DIAGNOSTIC FAILURE (0xFD)
     *
     * The keyboard periodically tests the sense amplifier and sends a diagnostic failure code if it detects
     * any problems. If a failure occurs during BAT, the keyboard stops scanning and waits for a system command
     * or power-down to restart. If a failure is reported after scanning is enabled, scanning continues.
     */
    DIAG_FAIL:  0xFD,

    /*
     * RESEND (0xFE)
     *
     * The keyboard issues a RESEND command following receipt of an invalid input, or any input with incorrect parity.
     * If the system sends nothing to the keyboard, no response is required.
     */
    RESEND:     0xFE,

    BUFF_FULL:  0xFF    // TODO: Verify this response code (is this just for older 83-key keyboards?)
};

Keyboard.LIMIT = {
    MAX_SCANCODES: 20   // TODO: Verify this limit for newer keyboards (84-key and up)
};

Keyboard.INJECTION = {
    NONE:       0,
    ON_START:   1,
    ON_INPUT:   2
};

/*
 * Initialize every Keyboard module on the page.
 */
Web.onInit(Keyboard.init);

if (NODE) module.exports = Keyboard;
