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
  Platform
} from 'react-native';
import { api, setToken } from './api';

const money = (fils, currency = 'AED') => `${(fils / 100).toFixed(2)} ${currency}`;

const STATUS_LABEL = {
  PENDING_PAYMENT: 'Awaiting payment',
  CONFIRMED: 'Confirmed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled'
};

export default function App() {
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
      Alert.alert(failureTitle, error.message);
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
      setScreen('courts');
    }, mode === 'register' ? 'Registration failed' : 'Login failed');

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

  const handleBook = () =>
    run(async () => {
      const emails = participants
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);

      await api.createBooking({
        courtId: selectedCourt._id,
        slotStart,
        participantEmails: emails
      });

      setParticipants('');
      setSlotStart('');
      setSelectedCourt(null);
      Alert.alert(
        'Booking created',
        'Each player now has their own payment link. The court is held until everyone pays.'
      );
      setScreen('bookings');
    }, 'Booking failed');

  const handleCancel = (id) =>
    run(async () => {
      const result = await api.cancelBooking(id);
      Alert.alert('Cancelled', `Refunded ${result.refundPercent}% to everyone who paid.`);
      loadBookings();
    }, 'Cancellation failed');

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>COURTSPLIT</Text>
          <Text style={styles.heroTitle}>Book the court. Split the bill.</Text>
          <Text style={styles.heroText}>
            Everyone pays their own share. The slot is only confirmed once the group is fully
            funded.
          </Text>
        </View>

        {user && (
          <View style={styles.tabs}>
            {['courts', 'bookings'].map((tab) => (
              <TouchableOpacity
                key={tab}
                style={[styles.tab, screen === tab && styles.tabActive]}
                onPress={() => setScreen(tab)}
              >
                <Text style={[styles.tabText, screen === tab && styles.tabTextActive]}>
                  {tab === 'courts' ? 'Find a court' : 'My bookings'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {loading && <ActivityIndicator size="large" color="#7BE04F" style={styles.loader} />}

        {screen === 'auth' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{mode === 'register' ? 'Create account' : 'Welcome back'}</Text>
            <Text style={styles.cardSubtitle}>
              {mode === 'register'
                ? 'Sign up to book courts and split costs with your group.'
                : 'Log in to continue.'}
            </Text>

            {mode === 'register' && (
              <Field label="Name" value={name} onChange={setName} placeholder="Your name" />
            )}
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
            />

            <TouchableOpacity style={styles.button} onPress={handleAuth} activeOpacity={0.9}>
              <Text style={styles.buttonText}>{mode === 'register' ? 'Sign up' : 'Log in'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setMode(mode === 'register' ? 'login' : 'register')}
            >
              <Text style={styles.secondaryButtonText}>
                {mode === 'register' ? 'I already have an account' : 'Create an account'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {screen === 'courts' && !selectedCourt && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Available courts</Text>
            {courts.length === 0 ? (
              <Text style={styles.muted}>No courts yet.</Text>
            ) : (
              courts.map((court) => (
                <TouchableOpacity
                  key={court._id}
                  style={styles.listItem}
                  onPress={() => setSelectedCourt(court)}
                >
                  <View style={styles.listItemHeader}>
                    <Text style={styles.listTitle}>{court.name}</Text>
                    <Text style={styles.priceChip}>{money(court.pricePerSlot, court.currency)}</Text>
                  </View>
                  <Text style={styles.muted}>
                    {court.venueName} · {court.location} · {court.sport}
                  </Text>
                  <Text style={styles.hint}>
                    Up to {court.capacity} players · {money(Math.ceil(court.pricePerSlot / court.capacity))} each
                  </Text>
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {screen === 'courts' && selectedCourt && (
          <View style={styles.card}>
            <Text style={styles.tag}>Booking</Text>
            <Text style={styles.cardTitle}>{selectedCourt.name}</Text>
            <Text style={styles.cardSubtitle}>
              {money(selectedCourt.pricePerSlot, selectedCourt.currency)} total, divided between
              everyone you add.
            </Text>

            <Field
              label="Start time (ISO)"
              value={slotStart}
              onChange={setSlotStart}
              placeholder="2026-08-01T18:00:00Z"
            />
            <Field
              label="Players (comma separated emails)"
              value={participants}
              onChange={setParticipants}
              placeholder="sam@example.com, alex@example.com"
              multiline
            />

            <TouchableOpacity style={styles.button} onPress={handleBook} activeOpacity={0.9}>
              <Text style={styles.buttonText}>Create booking</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setSelectedCourt(null)}>
              <Text style={styles.secondaryButtonText}>Back to courts</Text>
            </TouchableOpacity>
          </View>
        )}

        {screen === 'bookings' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>My bookings</Text>
            {bookings.length === 0 ? (
              <Text style={styles.muted}>Nothing booked yet.</Text>
            ) : (
              bookings.map((booking) => {
                const paid = booking.shares.filter((s) => s.status === 'paid').length;
                return (
                  <View key={booking._id} style={styles.listItem}>
                    <View style={styles.listItemHeader}>
                      <Text style={styles.listTitle}>{booking.court?.name || 'Court'}</Text>
                      <Text style={styles.priceChip}>{STATUS_LABEL[booking.status]}</Text>
                    </View>
                    <Text style={styles.muted}>
                      {new Date(booking.slotStart).toLocaleString()}
                    </Text>
                    <Text style={styles.hint}>
                      {paid} of {booking.shares.length} paid ·{' '}
                      {money(booking.totalAmount, booking.currency)} total
                    </Text>

                    {booking.shares.map((share) => (
                      <View key={share._id} style={styles.shareRow}>
                        <Text style={styles.shareEmail}>{share.email}</Text>
                        <Text
                          style={[
                            styles.shareStatus,
                            share.status === 'paid' && styles.sharePaid
                          ]}
                        >
                          {money(share.amount)} · {share.status}
                        </Text>
                      </View>
                    ))}

                    {['PENDING_PAYMENT', 'CONFIRMED'].includes(booking.status) && (
                      <TouchableOpacity
                        style={styles.secondaryButton}
                        onPress={() => handleCancel(booking._id)}
                      >
                        <Text style={styles.secondaryButtonText}>Cancel booking</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, value, onChange, placeholder, secure, multiline, keyboardType }) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.textarea]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#9DBFA4"
        secureTextEntry={secure}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#04150C',
    ...(Platform.OS === 'web'
      ? { backgroundImage: 'linear-gradient(135deg, #04150C 0%, #062A14 50%, #0B4522 100%)' }
      : {})
  },
  content: { padding: 20, paddingBottom: 36 },
  hero: {
    backgroundColor: 'rgba(8, 62, 26, 0.75)',
    borderRadius: 24,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)'
  },
  eyebrow: { color: '#7BE04F', fontSize: 12, fontWeight: '700', letterSpacing: 2.4, marginBottom: 8 },
  heroTitle: { color: '#fff', fontSize: 24, fontWeight: '800', marginBottom: 8 },
  heroText: { color: '#C6F3CA', fontSize: 14, lineHeight: 20 },
  tabs: { flexDirection: 'row', marginBottom: 14, gap: 10 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)'
  },
  tabActive: { backgroundColor: 'rgba(123,224,79,0.18)' },
  tabText: { color: '#C6F3CA', fontWeight: '600', fontSize: 13 },
  tabTextActive: { color: '#7BE04F', fontWeight: '800' },
  loader: { marginVertical: 8 },
  card: {
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)'
  },
  cardTitle: { color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 6 },
  cardSubtitle: { color: '#C6F3CA', fontSize: 13, marginBottom: 14, lineHeight: 18 },
  tag: {
    color: '#7BE04F',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 8,
    textTransform: 'uppercase'
  },
  inputGroup: { marginBottom: 10 },
  inputLabel: { color: '#C6F3CA', fontSize: 12, fontWeight: '600', marginBottom: 6, marginLeft: 2 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderColor: 'rgba(255,255,255,0.20)',
    borderWidth: 1,
    borderRadius: 14,
    color: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15
  },
  textarea: { minHeight: 72, textAlignVertical: 'top' },
  button: {
    backgroundColor: '#7BE04F',
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 8
  },
  buttonText: { color: '#04300F', fontWeight: '800', fontSize: 15 },
  secondaryButton: {
    borderColor: '#7BE04F',
    borderWidth: 1.2,
    paddingVertical: 11,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 10,
    backgroundColor: 'rgba(123,224,79,0.10)'
  },
  secondaryButtonText: { color: '#7BE04F', fontWeight: '700', fontSize: 13 },
  listItem: {
    borderTopColor: 'rgba(255,255,255,0.12)',
    borderTopWidth: 1,
    paddingTop: 12,
    marginTop: 12
  },
  listItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4
  },
  listTitle: { color: '#fff', fontSize: 16, fontWeight: '700', flex: 1, marginRight: 8 },
  priceChip: { color: '#7BE04F', fontWeight: '800', fontSize: 13 },
  muted: { color: '#C6F3CA', fontSize: 13, marginTop: 2 },
  hint: { color: '#8FBF97', fontSize: 12, marginTop: 4 },
  shareRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
    paddingVertical: 4
  },
  shareEmail: { color: '#C6F3CA', fontSize: 12, flex: 1 },
  shareStatus: { color: '#8FBF97', fontSize: 12, fontWeight: '600' },
  sharePaid: { color: '#7BE04F' }
});
