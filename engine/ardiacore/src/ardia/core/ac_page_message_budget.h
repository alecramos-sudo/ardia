#ifndef ARDIA_CORE_AC_PAGE_MESSAGE_BUDGET_H_
#define ARDIA_CORE_AC_PAGE_MESSAGE_BUDGET_H_

#include <stddef.h>

#include <algorithm>

namespace ardiacore {

struct PageMessageRate {
  double messages_per_second;
  double message_burst;
  double bytes_per_second;
  double byte_burst;
};

inline constexpr PageMessageRate kFramePageMessageRate = {
    .messages_per_second = 200,
    .message_burst = 400,
    .bytes_per_second = 8.0 * 1024 * 1024,
    .byte_burst = 16.0 * 1024 * 1024,
};

inline constexpr PageMessageRate kTabPageMessageRate = {
    .messages_per_second = 400,
    .message_burst = 800,
    .bytes_per_second = 16.0 * 1024 * 1024,
    .byte_burst = 32.0 * 1024 * 1024,
};

class PageMessageBudget {
 public:
  explicit PageMessageBudget(const PageMessageRate& rate)
      : rate_(rate), messages_(rate.message_burst), bytes_(rate.byte_burst) {}

  bool Allows(double now_seconds, size_t bytes) {
    Refill(now_seconds);
    return messages_ >= 1 && bytes_ >= static_cast<double>(bytes);
  }

  void Spend(size_t bytes) {
    messages_ -= 1;
    bytes_ -= static_cast<double>(bytes);
  }

 private:
  void Refill(double now_seconds) {
    if (!started_) {
      started_ = true;
      refilled_at_ = now_seconds;
      return;
    }
    const double elapsed = std::max(0.0, now_seconds - refilled_at_);
    refilled_at_ = std::max(refilled_at_, now_seconds);
    messages_ = std::min(rate_.message_burst,
                         messages_ + elapsed * rate_.messages_per_second);
    bytes_ = std::min(rate_.byte_burst, bytes_ + elapsed * rate_.bytes_per_second);
  }

  PageMessageRate rate_;
  double messages_;
  double bytes_;
  double refilled_at_ = 0;
  bool started_ = false;
};

inline bool AdmitPageMessage(PageMessageBudget& frame,
                             PageMessageBudget& tab,
                             double now_seconds,
                             size_t bytes) {
  if (!frame.Allows(now_seconds, bytes) || !tab.Allows(now_seconds, bytes)) {
    return false;
  }
  frame.Spend(bytes);
  tab.Spend(bytes);
  return true;
}

}

#endif
