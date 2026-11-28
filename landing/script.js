/* ============================================================
   CERBERUS-X Landing — Editorial Loading & Scroll Choreography
   Lenis Smooth Inertia Scroll · GSAP + ScrollTrigger · Same-Tab Curtain
   ============================================================ */

(function () {
  'use strict';

  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGSAP = false;

  /* Exact cubic-bezier(0.77, 0, 0.175, 1) solver so GSAP runs the exact editorial curve */
  function createBezierEase(p1x, p1y, p2x, p2y) {
    var cx = 3 * p1x;
    var bx = 3 * (p2x - p1x) - cx;
    var ax = 1 - cx - bx;
    var cy = 3 * p1y;
    var by = 3 * (p2y - p1y) - cy;
    var ay = 1 - cy - by;

    function sampleX(t) {
      return ((ax * t + bx) * t + cx) * t;
    }
    function sampleY(t) {
      return ((ay * t + by) * t + cy) * t;
    }
    function sampleDerivativeX(t) {
      return (3 * ax * t + 2 * bx) * t + cx;
    }

    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 6; i++) {
        var xEst = sampleX(t) - x;
        var dEst = sampleDerivativeX(t);
        if (Math.abs(xEst) < 1e-5 || Math.abs(dEst) < 1e-6) break;
        t -= xEst / dEst;
      }
      t = Math.max(0, Math.min(1, t));
      return sampleY(t);
    };
  }

  var EDITORIAL_EASE = createBezierEase(0.77, 0, 0.175, 1);

  var preloaderEl = document.getElementById('preloader');
  var preloaderBar = document.getElementById('preloaderBar');
  var preloaderCounter = document.getElementById('preloaderCounter');
  var pageCurtainEl = document.getElementById('pageCurtain');

  var lenisInstance = null;

  /* ----------------------------------------------------------
     1. HERO ENTRANCE STATE & HAND-OFF
     ---------------------------------------------------------- */
  function revealAllFallback() {
    document.querySelectorAll('.showcase-item').forEach(function (el) {
      el.classList.add('is-revealed');
    });
    document.querySelectorAll('.line-reveal__inner').forEach(function (el) {
      el.style.transform = 'none';
    });
    var divider = document.getElementById('philoDivider');
    if (divider) divider.style.transform = 'scaleY(1)';
  }

  function prepareInitialStates() {
    if (prefersReducedMotion || !hasGSAP) {
      revealAllFallback();
      return;
    }

    var fadeEls = ['#heroEyebrow', '#heroLead', '#heroSubtitle', '#heroActions'].filter(function (sel) {
      return Boolean(document.querySelector(sel));
    });
    if (fadeEls.length) {
      gsap.set(fadeEls, { opacity: 0, y: 26 });
    }
    if (document.querySelector('.hero__title')) {
      gsap.set('.hero__title', { opacity: 0, y: 40 });
    }
    if (document.querySelector('.hero__echo')) {
      gsap.set('.hero__echo', { opacity: 0, y: 28 });
    }
    if (document.querySelector('.line-reveal__inner')) {
      gsap.set('.line-reveal__inner', { y: '105%' });
    }
    if (document.getElementById('philoDivider')) {
      gsap.set('#philoDivider', { scaleY: 0 });
    }
  }

  function animateHeroEntrance() {
    if (prefersReducedMotion || !hasGSAP) return;

    var tl = gsap.timeline({ defaults: { ease: EDITORIAL_EASE } });

    if (document.querySelector('#heroEyebrow')) {
      tl.to('#heroEyebrow', { opacity: 1, y: 0, duration: 0.7 }, 0);
    }
    if (document.querySelector('.hero__echo')) {
      tl.to('.hero__echo', {
        opacity: 1,
        y: 0,
        duration: 0.85,
        stagger: 0.055
      }, 0.04);
    }
    if (document.querySelector('.hero__title')) {
      tl.to('.hero__title', { opacity: 1, y: 0, duration: 0.85 }, 0.14);
    }
    var leadSub = ['#heroLead', '#heroSubtitle'].filter(function (s) {
      return Boolean(document.querySelector(s));
    });
    if (leadSub.length) {
      tl.to(leadSub, {
        opacity: 1,
        y: 0,
        duration: 0.8,
        stagger: 0.08
      }, 0.24);
    }
    if (document.querySelector('#heroActions')) {
      tl.to('#heroActions', { opacity: 1, y: 0, duration: 0.7 }, 0.36);
    }
  }

  /* ----------------------------------------------------------
     2. PRELOADER & SAME-TAB PAGE TRANSITIONS
     ---------------------------------------------------------- */
  function finishPreloaderImmediately() {
    document.body.classList.remove('loading');
    if (preloaderEl) preloaderEl.style.display = 'none';
  }

  function exitPreloader() {
    if (!hasGSAP) {
      finishPreloaderImmediately();
      revealAllFallback();
      return;
    }

    var exitTl = gsap.timeline();

    // Vertical counter exit through overflow:hidden mask
    exitTl.to(preloaderCounter, {
      y: '-115%',
      opacity: 0,
      duration: 0.4,
      ease: EDITORIAL_EASE
    });

    // Wipe entire preloader curtain upward (900ms editorial ease)
    exitTl.to(preloaderEl, {
      clipPath: 'inset(0 0 100% 0)',
      duration: 0.9,
      ease: EDITORIAL_EASE,
      onStart: function () {
        document.body.classList.remove('loading');
        gsap.delayedCall(0.18, animateHeroEntrance);
      },
      onComplete: function () {
        if (preloaderEl) preloaderEl.style.display = 'none';
        initScrollAnimations();
        ScrollTrigger.refresh();
      }
    }, '-=0.1');
  }

  function runPreloader() {
    if (prefersReducedMotion || !hasGSAP || !preloaderEl) {
      finishPreloaderImmediately();
      initScrollAnimations();
      return;
    }

    // If arriving via in-app same-tab curtain navigation, wipe in smoothly without repeating the 1.6s count
    var isSameTabNav = false;
    try {
      isSameTabNav = window.sessionStorage && window.sessionStorage.getItem('cerberus_page_nav') === '1';
      if (isSameTabNav) {
        window.sessionStorage.removeItem('cerberus_page_nav');
      }
    } catch (_e) {
      isSameTabNav = false;
    }

    if (isSameTabNav) {
      if (preloaderCounter) preloaderCounter.textContent = '100';
      if (preloaderBar) preloaderBar.style.transform = 'scaleX(1)';
      gsap.to(preloaderEl, {
        clipPath: 'inset(0 0 100% 0)',
        duration: 0.75,
        ease: EDITORIAL_EASE,
        onStart: function () {
          document.body.classList.remove('loading');
          gsap.delayedCall(0.12, animateHeroEntrance);
        },
        onComplete: function () {
          if (preloaderEl) preloaderEl.style.display = 'none';
          initScrollAnimations();
          ScrollTrigger.refresh();
        }
      });
      return;
    }

    var state = { progress: 0 };

    gsap.to(state, {
      progress: 1,
      duration: 1.5,
      ease: 'power3.out',
      onUpdate: function () {
        var value = Math.round(state.progress * 100);
        if (preloaderCounter) {
          preloaderCounter.textContent = String(value).padStart(2, '0');
        }
        if (preloaderBar) {
          preloaderBar.style.transform = 'scaleX(' + state.progress + ')';
        }
      },
      onComplete: function () {
        gsap.delayedCall(0.2, exitPreloader);
      }
    });
  }

  function bindPageTransitions() {
    document.querySelectorAll('a[data-page-link="true"]').forEach(function (link) {
      link.addEventListener('click', function (e) {
        var href = link.getAttribute('href');
        if (!href) return;
        // Let modifier-key clicks open normally if requested by user
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

        e.preventDefault();
        closeMobileNav();

        try {
          if (window.sessionStorage) {
            window.sessionStorage.setItem('cerberus_page_nav', '1');
          }
        } catch (_e) { /* ignore storage failure */ }

        if (prefersReducedMotion || !hasGSAP || !pageCurtainEl) {
          window.location.href = href;
          return;
        }

        pageCurtainEl.style.pointerEvents = 'all';
        gsap.fromTo(pageCurtainEl,
          { clipPath: 'inset(100% 0 0 0)' },
          {
            clipPath: 'inset(0% 0 0 0)',
            duration: 0.55,
            ease: EDITORIAL_EASE,
            onComplete: function () {
              window.location.href = href;
            }
          }
        );
      });
    });
  }

  /* ----------------------------------------------------------
     3. LENIS SMOOTH SCROLL (Single Ticker Driven)
     ---------------------------------------------------------- */
  function initLenis() {
    if (prefersReducedMotion || typeof window.Lenis === 'undefined') return;

    lenisInstance = new Lenis({
      duration: 1.15,
      easing: function (t) {
        return Math.min(1, 1.001 - Math.pow(2, -10 * t));
      },
      orientation: 'vertical',
      gestureOrientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.8
    });

    if (hasGSAP) {
      lenisInstance.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(function (time) {
        lenisInstance.raf(time * 1000);
      });
      gsap.ticker.lagSmoothing(0);
    } else {
      var rafLoop = function (time) {
        lenisInstance.raf(time);
        requestAnimationFrame(rafLoop);
      };
      requestAnimationFrame(rafLoop);
    }
  }

  function bindAnchorNavigation() {
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
      anchor.addEventListener('click', function (e) {
        var href = this.getAttribute('href');
        if (!href || href === '#') return;
        var targetEl = document.querySelector(href);
        if (!targetEl) return;

        e.preventDefault();
        closeMobileNav();

        if (lenisInstance) {
          lenisInstance.scrollTo(targetEl, { offset: -72 });
        } else {
          targetEl.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth' });
        }
      });
    });
  }

  /* ----------------------------------------------------------
     4. SCROLL CHOREOGRAPHY (GSAP + ScrollTrigger)
     ---------------------------------------------------------- */
  function initScrollAnimations() {
    if (prefersReducedMotion || !hasGSAP) {
      revealAllFallback();
      return;
    }

    gsap.registerPlugin(ScrollTrigger);

    // A. Hero Echo Parallax
    document.querySelectorAll('.hero__echo').forEach(function (echo) {
      var depth = Number(echo.getAttribute('data-depth') || 1);
      gsap.fromTo(echo,
        { x: 0, y: 0 },
        {
          x: -depth * 10,
          y: -depth * 14,
          ease: 'none',
          scrollTrigger: {
            trigger: '.hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 0.8
          }
        }
      );
    });

    // B. Hairline Divider Draw
    var divider = document.getElementById('philoDivider');
    if (divider) {
      gsap.to(divider, {
        scaleY: 1,
        ease: 'none',
        scrollTrigger: {
          trigger: '#philosophy',
          start: 'top 85%',
          end: 'top 45%',
          scrub: 0.6
        }
      });
    }

    // C. Masked Line-by-Line Text Reveals (80ms stagger)
    var revealContainers = document.querySelectorAll('.philosophy__quote, .section-header, .philosophy__col');
    revealContainers.forEach(function (container) {
      var lines = container.querySelectorAll('.line-reveal__inner');
      if (!lines.length) return;

      gsap.to(lines, {
        y: '0%',
        duration: 0.85,
        stagger: 0.08,
        ease: EDITORIAL_EASE,
        scrollTrigger: {
          trigger: container,
          start: 'top 86%',
          once: true
        }
      });
    });

    // D. Clip-Path Showcase Reveals + Inner Scrub Parallax
    document.querySelectorAll('.showcase-item').forEach(function (item) {
      var parallaxWrap = item.querySelector('.showcase-item__parallax');

      ScrollTrigger.create({
        trigger: item,
        start: 'top 84%',
        once: true,
        onEnter: function () {
          item.classList.add('is-revealed');
        }
      });

      if (parallaxWrap) {
        gsap.fromTo(parallaxWrap,
          { yPercent: -8 },
          {
            yPercent: 8,
            ease: 'none',
            scrollTrigger: {
              trigger: item,
              start: 'top bottom',
              end: 'bottom top',
              scrub: true
            }
          }
        );
      }
    });

    // E. Card Grids & Console Panels Entrance
    [
      { selector: '.problem-card', trigger: '.problems__grid', stagger: 0.1 },
      { selector: '.stage-card', trigger: '.pipeline__stages', stagger: 0.1 },
      { selector: '.metric-card', trigger: '.benchmarks__metrics', stagger: 0.08 },
      { selector: '.tc-item', trigger: '.tc-list', stagger: 0.07 },
      { selector: '.service-card', trigger: '.services__grid', stagger: 0.1 },
      { selector: '.rail-block', trigger: '.console-rail', stagger: 0.08 }
    ].forEach(function (group) {
      var els = document.querySelectorAll(group.selector);
      var trig = document.querySelector(group.trigger);
      if (!els.length || !trig) return;

      gsap.fromTo(els,
        { opacity: 0, y: 28 },
        {
          opacity: 1,
          y: 0,
          duration: 0.75,
          stagger: group.stagger,
          ease: EDITORIAL_EASE,
          scrollTrigger: {
            trigger: trig,
            start: 'top 88%',
            once: true
          }
        }
      );
    });
  }

  /* ----------------------------------------------------------
     5. MOBILE NAV DRAWER
     ---------------------------------------------------------- */
  var navToggleEl = document.getElementById('navToggle');
  var mobileMenuEl = document.getElementById('mobileMenu');

  function closeMobileNav() {
    if (!mobileMenuEl || !navToggleEl) return;
    if (!mobileMenuEl.classList.contains('is-open')) return;
    mobileMenuEl.classList.remove('is-open');
    mobileMenuEl.setAttribute('aria-hidden', 'true');
    navToggleEl.setAttribute('aria-expanded', 'false');
    var spans = navToggleEl.querySelectorAll('span');
    spans[0].style.transform = '';
    spans[1].style.opacity = '';
    spans[2].style.transform = '';
  }

  function initMobileNav() {
    if (!navToggleEl || !mobileMenuEl) return;

    navToggleEl.addEventListener('click', function () {
      var isOpen = mobileMenuEl.classList.toggle('is-open');
      mobileMenuEl.setAttribute('aria-hidden', String(!isOpen));
      navToggleEl.setAttribute('aria-expanded', String(isOpen));
      var spans = navToggleEl.querySelectorAll('span');

      if (isOpen) {
        spans[0].style.transform = 'rotate(45deg) translate(4px, 4px)';
        spans[1].style.opacity = '0';
        spans[2].style.transform = 'rotate(-45deg) translate(4px, -4px)';
      } else {
        spans[0].style.transform = '';
        spans[1].style.opacity = '';
        spans[2].style.transform = '';
      }
    });
  }

  /* ----------------------------------------------------------
     6. BOOTSTRAP
     ---------------------------------------------------------- */
  function start() {
    hasGSAP = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

    initMobileNav();
    initLenis();
    bindAnchorNavigation();
    bindPageTransitions();
    prepareInitialStates();
    runPreloader();

    if (document.fonts && document.fonts.ready && hasGSAP) {
      document.fonts.ready.then(function () {
        if (window.ScrollTrigger) ScrollTrigger.refresh();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
