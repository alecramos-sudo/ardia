#ifndef ARDIA_CORE_AC_AUTOPLAY_H_
#define ARDIA_CORE_AC_AUTOPLAY_H_

namespace content {
class WebContents;
}

namespace ardiacore {

void InstallAutoplayPolicy();
void WatchAutoplay(content::WebContents* contents);
void SetBlockAutoplayEverywhere(bool enabled);
bool BlocksAutoplayEverywhere();

}

#endif
