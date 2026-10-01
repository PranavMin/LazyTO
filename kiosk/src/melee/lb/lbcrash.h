#ifndef MELEE_LB_LBCRASH_H
#define MELEE_LB_LBCRASH_H

#include <Runtime/platform.h>

/* Chain a crash recorder in front of Melee's OS error handlers (DSI, ISI,
 * alignment, program). Call once, any time after OSInit and after
 * db_SetupCrashHandler; later calls are ignored. */
void lbCrash_Install(void);

#endif
