#ifndef KIOSK_LBMODULE_GLUE_H
#define KIOSK_LBMODULE_GLUE_H

#include <Runtime/platform.h>

/* Character select helpers the kiosk needs that vanilla Melee keeps static or
 * inline; lbmodule_glue.c defines them against vanilla data. */

/* The CSS port's slot type (Gm_PKind_*). */
u8 mnCharSel_PortSlotType(int port);

/* The CSS's own "everyone ready, start the fight" check; true if it started. */
bool mnCharSel_TryStartFight(void);

#endif
