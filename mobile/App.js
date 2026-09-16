import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
  StatusBar,
  useWindowDimensions
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useFonts,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold
} from '@expo-google-fonts/plus-jakarta-sans';
import { api, setToken } from './api';

const colors = {
  bg: '#F5F6F8',
  surface: '#FFFFFF',
  border: '#E6E8EC',
  text: '#101828',
  muted: '#667085',
  subtle: '#98A2B3',
  accent: '#2E6BE6',
  accentSoft: '#EBF1FD',
  danger: '#D92D20'
};

const font = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  extrabold: 'PlusJakartaSans_800ExtraBold'
};

// At or above this width the app switches from the phone layout (bottom tabs,
// single column) to a website layout (top nav, grids, side-by-side form).
const WIDE_BREAKPOINT = 900;
const MAX_CONTENT_WIDTH = 1120;
const PAGE_PADDING = 32;
const GAP = 16;

const STATUS = {
  PENDING_PAYMENT: { label: 'Awaiting payment', fg: '#B54708', bg: '#FEF4E6' },
  CONFIRMED: { label: 'Confirmed', fg: '#067647', bg: '#E7F6EC' },
  EXPIRED: { label: 'Expired', fg: '#B42318', bg: '#FDEDEC' },
  CANCELLED: { label: 'Cancelled', fg: '#475467', bg: '#F0F1F3' }
};

const SHARE_COLOR = { paid: '#067647', pending: '#B54708', refunded: '#475467' };

const SPORT_TINT = {
  padel: { fg: '#2E6BE6', bg: '#EBF1FD' },
  football: { fg: '#067647', bg: '#E7F6EC' }
};

const money = (fils, currency = 'AED') => `${currency} ${(fils / 100).toFixed(2)}`;

// Alert.alert is a no-op in react-native-web, so errors and confirmations
// would silently vanish in the browser build.
const notify = (title, message) =>
  Platform.OS === 'web' ? window.alert(`${title}\n\n${message}`) : Alert.alert(title, message);

const formatSlot = (iso) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
};

// Tomorrow at 18:00 local time, so the form starts with a bookable slot.
const defaultSlot = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(18, 0, 0, 0);
  return d.toISOString();
};

/** Column count and item width for a card grid at the current window width. */
function useLayout() {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const inner = Math.min(width, MAX_CONTENT_WIDTH) - PAGE_PADDING * 2;
  const grid = (maxColumns) => {
    if (!wide) return { columns: 1, itemStyle: null };
    const columns = inner >= 960 ? maxColumns : Math.min(maxColumns, 2);
    return {
      columns,
      itemStyle: { width: (inner - GAP * (columns - 1)) / columns, marginBottom: 0 }
    };
  };
  return { wide, grid };
}

const TABS = [
  { key: 'courts', label: 'Courts', icon: 'tennisball' },
  { key: 'bookings', label: 'Bookings', icon: 'calendar' }
];

const PAGE_COPY = {
  courts: { title: 'Find a court', subtitle: 'Pick a court, invite your group, and split the cost.' },
  bookings: { title: 'My bookings', subtitle: 'Everything you organise or play in.' },
  book: { title: 'New booking', subtitle: 'The slot is held while everyone pays their share.' }
};

export default function App() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold
  });
  const layout = useLayout();
  const { wide } = layout;

  const [screen, setScreen] = useState('auth');
  const [loading, setLoading] = useState(false);

  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState(null);

  const [courts, setCourts] = useState([]);
  const [selectedCourt, setSelectedCourt] = useState(null);
  const [slotStart, setSlotStart] = useState('');
  const [participants, setParticipants] = useState('');

  const [bookings, setBookings] = useState([]);

  useEffect(() => {
    if (screen === 'courts') loadCourts();
    if (screen === 'bookings') loadBookings();
  }, [screen]);

  const run = async (fn, failureTitle) => {
    try {
      setLoading(true);
      return await fn();
    } catch (error) {
      notify(failureTitle, error.message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handleAuth = () =>
    run(async () => {
      const payload =
        mode === 'register' ? { name, email, password } : { email, password };
      const data = await (mode === 'register' ? api.register(payload) : api.login(payload));
      setToken(data.token);
      setUser(data.user);
      setPassword('');
      setScreen('courts');
    }, mode === 'register' ? 'Registration failed' : 'Login failed');

  const handleLogout = () => {
    setToken(null);
    setUser(null);
    setSelectedCourt(null);
    setBookings([]);
    setMode('login');
    setScreen('auth');
  };

  const loadCourts = () =>
    run(async () => {
      const data = await api.listCourts();
      setCourts(data.courts || []);
    }, 'Could not load courts');

  const loadBookings = () =>
    run(async () => {
      const data = await api.myBookings();
      setBookings(data.bookings || []);
    }, 'Could not load bookings');

  const participantEmails = participants
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  const selectCourt = (court) => {
    setSelectedCourt(court);
    setSlotStart(defaultSlot());
  };

  const goTo = (tab) => {
    setSelectedCourt(null);
    setScreen(tab);
  };

  const handleBook = () =>
    run(async () => {
      await api.createBooking({
        courtId: selectedCourt._id,
        slotStart,
        participantEmails
      });

      setParticipants('');
      setSlotStart('');
      setSelectedCourt(null);
      notify(
        'Booking created',
        'Each player now has their own payment link. The court is held until everyone pays.'
      );
      setScreen('bookings');
    }, 'Booking failed');

  const handleCancel = (id) =>
    run(async () => {
      const result = await api.cancelBooking(id);
      notify('Booking cancelled', `Refunded ${result.refundPercent}% to everyone who paid.`);
      loadBookings();
    }, 'Cancellation failed');

  if (!fontsLoaded) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (screen === 'auth') {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="dark-content" />
        <AuthScreen
          wide={wide}
          mode={mode}
          setMode={setMode}
          name={name}
          setName={setName}
          email={email}
          setEmail={setEmail}
          password={password}
          setPassword={setPassword}
          onSubmit={handleAuth}
          loading={loading}
        />
      </SafeAreaView>
    );
  }

  const booking = screen === 'courts' && selectedCourt;
  const page = PAGE_COPY[booking ? 'book' : screen];

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <View style={wide ? styles.flex : styles.phoneFrame}>
        {wide ? (
          <TopNav screen={screen} user={user} onNavigate={goTo} onLogout={handleLogout} />
        ) : (
          <View style={styles.header}>
            {booking ? (
              <TouchableOpacity style={styles.headerBack} onPress={() => setSelectedCourt(null)}>
                <Ionicons name="chevron-back" size={22} color={colors.text} />
                <Text style={styles.headerTitle}>{page.title}</Text>
              </TouchableOpacity>
            ) : (
              <View>
                <Text style={styles.headerEyebrow}>
                  {user?.name ? `Hi, ${user.name.split(' ')[0]}` : 'CourtSplit'}
                </Text>
                <Text style={styles.headerTitle}>{page.title}</Text>
              </View>
            )}
            <TouchableOpacity style={styles.iconButton} onPress={handleLogout}>
              <Ionicons name="log-out-outline" size={20} color={colors.muted} />
            </TouchableOpacity>
          </View>
        )}

        <ScrollView
          style={styles.flex}
          contentContainerStyle={wide ? styles.contentWide : styles.content}
          showsVerticalScrollIndicator={false}
        >
          {wide && (
            <View style={styles.pageHeader}>
              {booking && (
                <TouchableOpacity style={styles.backLink} onPress={() => setSelectedCourt(null)}>
                  <Ionicons name="arrow-back" size={16} color={colors.muted} />
                  <Text style={styles.backLinkText}>All courts</Text>
                </TouchableOpacity>
              )}
              <Text style={styles.pageTitle}>{page.title}</Text>
              <Text style={styles.pageSubtitle}>{page.subtitle}</Text>
            </View>
          )}

          {loading && <ActivityIndicator color={colors.accent} style={styles.loader} />}

          {screen === 'courts' && !selectedCourt && (
            <CourtList courts={courts} onSelect={selectCourt} loading={loading} grid={layout.grid(3)} />
          )}

          {booking && (
            <BookingForm
              wide={wide}
              court={selectedCourt}
              slotStart={slotStart}
              setSlotStart={setSlotStart}
              participants={participants}
              setParticipants={setParticipants}
              playerCount={new Set([user?.email, ...participantEmails]).size}
              onSubmit={handleBook}
              loading={loading}
            />
          )}

          {screen === 'bookings' && (
            <BookingList
              bookings={bookings}
              onCancel={handleCancel}
              loading={loading}
              grid={layout.grid(2)}
            />
          )}
        </ScrollView>

        {!wide && (
          <View style={styles.tabBar}>
            {TABS.map((tab) => {
              const active = screen === tab.key;
              return (
                <TouchableOpacity key={tab.key} style={styles.tabItem} onPress={() => goTo(tab.key)}>
                  <Ionicons
                    name={active ? tab.icon : `${tab.icon}-outline`}
                    size={22}
                    color={active ? colors.accent : colors.subtle}
                  />
                  <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{tab.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

function TopNav({ screen, user, onNavigate, onLogout }) {
  return (
    <View style={styles.topNav}>
      <View style={styles.topNavInner}>
        <View style={styles.row}>
          <View style={styles.logoSmall}>
            <Ionicons name="tennisball" size={16} color="#fff" />
          </View>
          <Text style={styles.wordmark}>CourtSplit</Text>
        </View>

        <View style={styles.navLinks}>
          {TABS.map((tab) => {
            const active = screen === tab.key;
            return (
              <TouchableOpacity key={tab.key} style={styles.navLink} onPress={() => onNavigate(tab.key)}>
                <Text style={[styles.navLinkText, active && styles.navLinkTextActive]}>
                  {tab.label}
                </Text>
                <View style={[styles.navUnderline, active && styles.navUnderlineActive]} />
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.row}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(user?.name || user?.email || '?')[0].toUpperCase()}</Text>
          </View>
          <Text style={styles.navUser}>{user?.name}</Text>
          <TouchableOpacity style={styles.logoutButton} onPress={onLogout}>
            <Ionicons name="log-out-outline" size={18} color={colors.muted} />
            <Text style={styles.logoutText}>Log out</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function AuthScreen({ wide, ...props }) {
  if (!wide) {
    return (
      <ScrollView contentContainerStyle={styles.authContent} keyboardShouldPersistTaps="handled">
        <AuthForm {...props} />
      </ScrollView>
    );
  }

  return (
    <View style={styles.authSplit}>
      <View style={styles.brandPanel}>
        <View style={styles.row}>
          <View style={styles.logoOnAccent}>
            <Ionicons name="tennisball" size={18} color={colors.accent} />
          </View>
          <Text style={styles.wordmarkOnAccent}>CourtSplit</Text>
        </View>

        <View>
          <Text style={styles.brandTitle}>Book the court.{'\n'}Split the bill.</Text>
          <Text style={styles.brandText}>
            No more fronting the whole booking and chasing friends for money.
          </Text>
          {[
            ['people-outline', 'Everyone pays their own share'],
            ['time-outline', 'The slot is held while your group pays'],
            ['refresh-outline', 'Automatic refunds if it falls through']
          ].map(([icon, text]) => (
            <View key={text} style={styles.brandFeature}>
              <View style={styles.brandFeatureIcon}>
                <Ionicons name={icon} size={16} color="#fff" />
              </View>
              <Text style={styles.brandFeatureText}>{text}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.brandFootnote}>Padel · Football</Text>
      </View>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.authFormPane}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.authFormWide}>
          <AuthForm {...props} hideLogo />
        </View>
      </ScrollView>
    </View>
  );
}

function AuthForm({
  mode,
  setMode,
  name,
  setName,
  email,
  setEmail,
  password,
  setPassword,
  onSubmit,
  loading,
  hideLogo
}) {
  const registering = mode === 'register';
  return (
    <>
      {!hideLogo && (
        <View style={styles.logo}>
          <Ionicons name="tennisball" size={26} color="#fff" />
        </View>
      )}
      <Text style={styles.authTitle}>{registering ? 'Create your account' : 'Welcome back'}</Text>
      <Text style={styles.authSubtitle}>
        {registering
          ? 'Sign up to book courts and split costs with your group.'
          : 'Book a court with friends. Everyone pays their own share.'}
      </Text>

      {registering && <Field label="Name" value={name} onChange={setName} placeholder="Your name" />}
      <Field
        label="Email"
        value={email}
        onChange={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
      />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        placeholder="At least 8 characters"
        secure
        onSubmitEditing={onSubmit}
      />

      <PrimaryButton
        label={registering ? 'Create account' : 'Log in'}
        onPress={onSubmit}
        loading={loading}
      />

      <TouchableOpacity
        style={styles.linkButton}
        onPress={() => setMode(registering ? 'login' : 'register')}
      >
        <Text style={styles.linkText}>
          {registering ? 'Already have an account? ' : 'New to CourtSplit? '}
          <Text style={styles.linkTextStrong}>{registering ? 'Log in' : 'Sign up'}</Text>
        </Text>
      </TouchableOpacity>
    </>
  );
}

function Grid({ grid, children }) {
  return grid.columns > 1 ? <View style={styles.grid}>{children}</View> : children;
}

function CourtList({ courts, onSelect, loading, grid }) {
  if (!courts.length) {
    return loading ? null : <EmptyState icon="tennisball-outline" text="No courts available yet." />;
  }
  return (
    <Grid grid={grid}>
      {courts.map((court) => {
        const tint = SPORT_TINT[court.sport] || { fg: colors.muted, bg: '#F0F1F3' };
        return (
          <TouchableOpacity
            key={court._id}
            style={[styles.card, grid.itemStyle]}
            onPress={() => onSelect(court)}
            activeOpacity={0.7}
          >
            <View style={styles.row}>
              <View style={[styles.courtTile, { backgroundColor: tint.bg }]}>
                <Ionicons
                  name={court.sport === 'football' ? 'football-outline' : 'tennisball-outline'}
                  size={22}
                  color={tint.fg}
                />
              </View>
              <View style={styles.flex}>
                <Text style={styles.cardTitle}>{court.name}</Text>
                <Text style={styles.cardMeta}>{court.venueName}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
            </View>

            <View style={styles.divider} />

            <View style={styles.rowBetween}>
              <View style={styles.row}>
                <Meta icon="location-outline" text={court.location} />
                <Meta icon="people-outline" text={`Up to ${court.capacity}`} />
              </View>
              <Text style={styles.price}>
                {money(court.pricePerSlot, court.currency)}
                <Text style={styles.priceUnit}> /hr</Text>
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </Grid>
  );
}

function BookingForm({
  wide,
  court,
  slotStart,
  setSlotStart,
  participants,
  setParticipants,
  playerCount,
  onSubmit,
  loading
}) {
  const overCapacity = playerCount > court.capacity;
  const validSlot = slotStart && !Number.isNaN(new Date(slotStart).getTime());

  const details = (
    <>
      <View style={styles.card}>
        <Text style={styles.cardMeta}>{court.venueName}</Text>
        <Text style={styles.cardTitleLarge}>{court.name}</Text>
        <View style={[styles.row, styles.mt8]}>
          <Meta icon="location-outline" text={court.location} />
          <Meta icon="people-outline" text={`Up to ${court.capacity}`} />
        </View>
      </View>

      <Text style={styles.sectionLabel}>Details</Text>
      <View style={styles.card}>
        <Field
          label="Start time"
          value={slotStart}
          onChange={setSlotStart}
          placeholder={defaultSlot()}
          hint={validSlot ? formatSlot(slotStart) : 'ISO date, e.g. 2026-10-20T18:00:00Z'}
        />
        <Field
          label="Invite players"
          value={participants}
          onChange={setParticipants}
          placeholder="sam@example.com, alex@example.com"
          hint="Comma-separated emails of registered players"
          multiline
          last
        />
      </View>
    </>
  );

  const summary = (
    <>
      <Text style={styles.sectionLabel}>Split</Text>
      <View style={styles.card}>
        <SummaryRow label="Court, 1 hour" value={money(court.pricePerSlot, court.currency)} />
        <SummaryRow label="Players" value={String(playerCount)} />
        {wide && validSlot && <SummaryRow label="When" value={formatSlot(slotStart)} />}
        <View style={styles.divider} />
        <SummaryRow
          label="Each pays"
          value={money(Math.ceil(court.pricePerSlot / playerCount), court.currency)}
          strong
        />
        {overCapacity && (
          <View style={styles.warning}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
            <Text style={styles.warningText}>This court holds {court.capacity} players.</Text>
          </View>
        )}
      </View>

      <PrimaryButton label="Create booking" onPress={onSubmit} loading={loading} />
      <Text style={styles.footnote}>
        The slot is held while everyone pays. If the group isn't fully funded in time, everyone
        who paid is refunded automatically.
      </Text>
    </>
  );

  if (!wide) {
    return (
      <>
        {details}
        {summary}
      </>
    );
  }
  return (
    <View style={styles.formColumns}>
      <View style={styles.flex}>{details}</View>
      <View style={styles.formAside}>{summary}</View>
    </View>
  );
}

function BookingList({ bookings, onCancel, loading, grid }) {
  if (!bookings.length) {
    return loading ? null : <EmptyState icon="calendar-outline" text="You have no bookings yet." />;
  }
  return (
    <Grid grid={grid}>
      {bookings.map((booking) => {
        const status = STATUS[booking.status] || STATUS.CANCELLED;
        const paid = booking.shares.filter((s) => s.status === 'paid').length;
        const open = ['PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status);
        return (
          <View key={booking.id} style={[styles.card, grid.itemStyle]}>
            <View style={styles.rowBetween}>
              <View style={styles.flex}>
                <Text style={styles.cardTitle}>{booking.court?.name || 'Court'}</Text>
                <Text style={styles.cardMeta}>{booking.court?.venueName}</Text>
              </View>
              <View style={[styles.pill, { backgroundColor: status.bg }]}>
                <Text style={[styles.pillText, { color: status.fg }]}>{status.label}</Text>
              </View>
            </View>

            <View style={[styles.row, styles.mt12]}>
              <Meta icon="time-outline" text={formatSlot(booking.slotStart)} />
            </View>

            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>
                {paid} of {booking.shares.length} paid
              </Text>
              <Text style={styles.progressLabel}>{money(booking.totalAmount, booking.currency)}</Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[styles.progressFill, { width: `${(paid / booking.shares.length) * 100}%` }]}
              />
            </View>

            <View style={styles.divider} />

            {booking.shares.map((share) => (
              <View key={share.id} style={styles.shareRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{share.email[0].toUpperCase()}</Text>
                </View>
                <Text style={styles.shareEmail} numberOfLines={1}>
                  {share.email}
                </Text>
                <View style={styles.shareRight}>
                  <Text style={styles.shareAmount}>{money(share.amount, booking.currency)}</Text>
                  <Text style={[styles.shareStatus, { color: SHARE_COLOR[share.status] }]}>
                    {share.status}
                  </Text>
                </View>
              </View>
            ))}

            {open && (
              <TouchableOpacity style={styles.cancelButton} onPress={() => onCancel(booking.id)}>
                <Text style={styles.cancelText}>Cancel booking</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </Grid>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  multiline,
  keyboardType,
  hint,
  last,
  onSubmitEditing
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.field, last && styles.fieldLast]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.textarea, focused && styles.inputFocused]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.subtle}
        secureTextEntry={secure}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize="none"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={onSubmitEditing}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

function PrimaryButton({ label, onPress, loading }) {
  return (
    <TouchableOpacity
      style={[styles.primaryButton, loading && styles.primaryButtonDisabled]}
      onPress={onPress}
      disabled={loading}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

function Meta({ icon, text }) {
  return (
    <View style={styles.meta}>
      <Ionicons name={icon} size={14} color={colors.muted} />
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

function SummaryRow({ label, value, strong }) {
  return (
    <View style={[styles.rowBetween, styles.summaryRow]}>
      <Text style={strong ? styles.summaryLabelStrong : styles.summaryLabel}>{label}</Text>
      <Text style={strong ? styles.summaryValueStrong : styles.summaryValue}>{value}</Text>
    </View>
  );
}

function EmptyState({ icon, text }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={32} color={colors.subtle} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  phoneFrame: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center' },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mt8: { marginTop: 8 },
  mt12: { marginTop: 12 },

  // Phone header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12
  },
  headerEyebrow: { fontFamily: font.medium, fontSize: 13, color: colors.muted },
  headerTitle: { fontFamily: font.bold, fontSize: 24, color: colors.text, letterSpacing: -0.5 },
  headerBack: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -4 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border
  },

  // Desktop navigation
  topNav: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  topNavInner: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: PAGE_PADDING,
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  logoSmall: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center'
  },
  wordmark: { fontFamily: font.bold, fontSize: 17, color: colors.text, letterSpacing: -0.3 },
  navLinks: { flexDirection: 'row', gap: 28, alignSelf: 'stretch' },
  navLink: { justifyContent: 'center', alignItems: 'center' },
  navLinkText: { fontFamily: font.medium, fontSize: 14, color: colors.muted },
  navLinkTextActive: { fontFamily: font.semibold, color: colors.text },
  navUnderline: {
    position: 'absolute',
    bottom: -1,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'transparent'
  },
  navUnderlineActive: { backgroundColor: colors.accent },
  navUser: { fontFamily: font.medium, fontSize: 14, color: colors.text, marginLeft: -2 },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    marginLeft: 8
  },
  logoutText: { fontFamily: font.medium, fontSize: 13, color: colors.muted },

  // Page content
  content: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 24 },
  contentWide: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: PAGE_PADDING,
    paddingTop: 36,
    paddingBottom: 64
  },
  pageHeader: { marginBottom: 24 },
  pageTitle: { fontFamily: font.bold, fontSize: 30, color: colors.text, letterSpacing: -0.8 },
  pageSubtitle: { fontFamily: font.regular, fontSize: 15, color: colors.muted, marginTop: 4 },
  backLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  backLinkText: { fontFamily: font.medium, fontSize: 14, color: colors.muted },
  loader: { marginVertical: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP, alignItems: 'flex-start' },
  formColumns: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  formAside: { width: 360 },

  // Auth
  authContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  authSplit: { flex: 1, flexDirection: 'row' },
  brandPanel: {
    flex: 1,
    maxWidth: 560,
    backgroundColor: colors.accent,
    padding: 48,
    justifyContent: 'space-between'
  },
  logoOnAccent: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  wordmarkOnAccent: { fontFamily: font.bold, fontSize: 18, color: '#fff', letterSpacing: -0.3 },
  brandTitle: {
    fontFamily: font.bold,
    fontSize: 44,
    lineHeight: 52,
    color: '#fff',
    letterSpacing: -1.2
  },
  brandText: {
    fontFamily: font.regular,
    fontSize: 17,
    lineHeight: 26,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 16,
    marginBottom: 32,
    maxWidth: 400
  },
  brandFeature: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  brandFeatureIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  brandFeatureText: { fontFamily: font.medium, fontSize: 15, color: '#fff' },
  brandFootnote: { fontFamily: font.medium, fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  authFormPane: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 48 },
  authFormWide: { width: '100%', maxWidth: 400 },
  logo: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24
  },
  authTitle: { fontFamily: font.bold, fontSize: 28, color: colors.text, letterSpacing: -0.6 },
  authSubtitle: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
    marginTop: 6,
    marginBottom: 28
  },
  linkButton: { alignItems: 'center', paddingVertical: 16 },
  linkText: { fontFamily: font.regular, fontSize: 14, color: colors.muted },
  linkTextStrong: { fontFamily: font.semibold, color: colors.accent },

  // Cards
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border
  },
  cardTitle: { fontFamily: font.semibold, fontSize: 16, color: colors.text },
  cardTitleLarge: {
    fontFamily: font.bold,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.4,
    marginTop: 2
  },
  cardMeta: { fontFamily: font.regular, fontSize: 13, color: colors.muted, marginTop: 2 },
  courtTile: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 14 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontFamily: font.medium, fontSize: 13, color: colors.muted },
  price: { fontFamily: font.bold, fontSize: 15, color: colors.text },
  priceUnit: { fontFamily: font.regular, fontSize: 13, color: colors.muted },

  sectionLabel: {
    fontFamily: font.semibold,
    fontSize: 13,
    color: colors.muted,
    marginTop: 8,
    marginBottom: 8,
    marginLeft: 4
  },

  // Forms
  field: { marginBottom: 16 },
  fieldLast: { marginBottom: 0 },
  fieldLabel: { fontFamily: font.semibold, fontSize: 13, color: colors.text, marginBottom: 6 },
  fieldHint: { fontFamily: font.regular, fontSize: 12, color: colors.muted, marginTop: 6 },
  input: {
    fontFamily: font.regular,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {})
  },
  inputFocused: { borderColor: colors.accent },
  textarea: { minHeight: 76, textAlignVertical: 'top' },

  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8
  },
  primaryButtonDisabled: { opacity: 0.7 },
  primaryButtonText: { fontFamily: font.semibold, fontSize: 15, color: '#fff' },

  summaryRow: { paddingVertical: 4 },
  summaryLabel: { fontFamily: font.regular, fontSize: 14, color: colors.muted },
  summaryValue: { fontFamily: font.medium, fontSize: 14, color: colors.text },
  summaryLabelStrong: { fontFamily: font.semibold, fontSize: 15, color: colors.text },
  summaryValueStrong: { fontFamily: font.bold, fontSize: 17, color: colors.text },
  warning: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  warningText: { fontFamily: font.medium, fontSize: 13, color: colors.danger },
  footnote: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 12
  },

  // Bookings
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, marginLeft: 8 },
  pillText: { fontFamily: font.semibold, fontSize: 12 },
  progressHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  progressLabel: { fontFamily: font.medium, fontSize: 12, color: colors.muted },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#EEF0F3',
    marginTop: 6,
    overflow: 'hidden'
  },
  progressFill: { height: '100%', borderRadius: 3, backgroundColor: colors.accent },

  shareRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10
  },
  avatarText: { fontFamily: font.semibold, fontSize: 12, color: colors.accent },
  shareEmail: { flex: 1, fontFamily: font.regular, fontSize: 14, color: colors.text },
  shareRight: { alignItems: 'flex-end', marginLeft: 8 },
  shareAmount: { fontFamily: font.semibold, fontSize: 13, color: colors.text },
  shareStatus: { fontFamily: font.medium, fontSize: 12, textTransform: 'capitalize' },
  cancelButton: {
    marginTop: 12,
    height: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  cancelText: { fontFamily: font.semibold, fontSize: 14, color: colors.danger },

  empty: { alignItems: 'center', paddingVertical: 48, gap: 10 },
  emptyText: { fontFamily: font.medium, fontSize: 14, color: colors.muted },

  // Phone tab bar
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 4 : 10
  },
  tabItem: { flex: 1, alignItems: 'center', gap: 2 },
  tabLabel: { fontFamily: font.medium, fontSize: 11, color: colors.subtle },
  tabLabelActive: { fontFamily: font.semibold, color: colors.accent }
});
